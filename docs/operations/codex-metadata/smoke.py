"""Exercise the packaged metadata runtime and its code-mode host against a loopback model."""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import secrets
import shlex
import subprocess
import sys
import tempfile
from threading import Event, Thread


def smoke(binary):
    windows = os.name == "nt"
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp).resolve()
        home = root / "home"
        codex_home = home / ".codex"
        repo = root / "repo"
        repo.mkdir()
        codex_home.mkdir(parents=True)
        env = {k: os.environ[k] for k in (
            "PATH", "SystemRoot", "ComSpec", "PATHEXT", "PROGRAMFILES", "ProgramFiles(x86)",
            "ProgramW6432", "TEMP", "TMP", "TMPDIR",
        ) if k in os.environ}
        env.update(HOME=str(home), USERPROFILE=str(home), CODEX_HOME=str(codex_home),
                   GIT_CONFIG_NOSYSTEM="1", NO_PROXY="127.0.0.1",
                   HTTP_PROXY="http://127.0.0.1:1", HTTPS_PROXY="http://127.0.0.1:1",
                   ALL_PROXY="http://127.0.0.1:1")
        if windows:
            for key, directory in (("LOCALAPPDATA", "Local"), ("APPDATA", "Roaming")):
                location = home / "AppData" / directory
                location.mkdir(parents=True)
                env[key] = str(location)
        subprocess.run(["git", "init", "-q", str(repo)], env=env, check=True, timeout=10)
        marker = secrets.token_hex(16)
        (repo / "evidence.txt").write_text(marker)
        personal, project, developer = "release-smoke-personal", "release-smoke-repo", "release-smoke-developer"
        (codex_home / "AGENTS.md").write_text(personal)
        (repo / "AGENTS.md").write_text(project)
        account_start, cli_start = root / "account-mcp-start", root / "cli-mcp-start"

        def server_args(start_marker):
            return json.dumps(["-I", "-c", "import pathlib,sys; pathlib.Path(sys.argv[1]).touch()",
                               str(start_marker)])

        outputs = []
        first_input = ""
        child_inputs = []
        child_started = Event()
        child_prompt = "Confirm this repository review is ready."
        rg = binary.parent.parent / "codex-path" / ("rg.exe" if windows else "rg")
        # Exercise the packaged helper even on builders that already have ripgrep on PATH.
        quoted_rg = "& '" + str(rg).replace("'", "''") + "'" if windows else shlex.quote(str(rg))
        command = f"{quoted_rg} --no-config . evidence.txt"
        code = (f"const cmd = {json.dumps(command)};\n"
                "text(typeof tools.exec_command === 'function' "
                "? await tools.exec_command({cmd, login:false}) "
                ": await tools.shell_command({command:cmd, login:false}));")

        class Model(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                nonlocal first_input
                if self.path != "/v1/responses" or self.headers.get("Authorization"):
                    self.send_error(400)
                    return
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                tool_namespace = next((t for t in request["tools"] if t.get("type") == "namespace"
                                       and t.get("name") == "functions"), {})

                def run_code(call_id, source):
                    item = {"type": "custom_tool_call", "name": "exec", "call_id": call_id, "input": source}
                    if any(tool.get("name") == "exec" for tool in tool_namespace.get("tools", [])):
                        item["namespace"] = "functions"
                    return item

                child = (self.headers.get("x-openai-subagent")
                         or request.get("client_metadata", {}).get("x-openai-subagent")) == "collab_spawn"
                if child:
                    child_inputs.append(json.dumps(request["input"]))
                    child_started.set()
                    item = {"type": "message", "id": "child-reply", "role": "assistant",
                            "content": [{"type": "output_text", "text": "review ready"}]}
                elif not outputs:
                    first_input = json.dumps(request["input"])
                    item = run_code("read", code)
                elif len(outputs) == 1:
                    args = json.dumps({"task_name": "reviewer", "message": child_prompt, "fork_turns": "none"})
                    if any(t.get("name") == "collaboration" and
                           any(tool.get("name") == "spawn_agent" for tool in t.get("tools", []))
                           for t in request["tools"]):
                        item = {"type": "function_call", "namespace": "collaboration", "name": "spawn_agent",
                                "call_id": "spawn", "arguments": args}
                    else:
                        item = run_code("spawn", f"text(await tools.collaboration__spawn_agent({args}));")
                else:
                    # Requests from the parent and child can arrive in either order.
                    child_started.wait(timeout=15)
                    item = {"type": "message", "id": "reply", "role": "assistant",
                            "content": [{"type": "output_text", "text": "repository read complete"}]}
                if not child:
                    outputs.append([i for i in request["input"] if i.get("type") in
                                    ("custom_tool_call_output", "function_call_output")])
                response = {"id": "child" if child else "r" + str(len(outputs))}
                events = [
                    {"type": "response.created", "response": response},
                    {"type": "response.output_item.done", "item": item},
                    {"type": "response.completed", "response": response},
                ]
                body = "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        with ThreadingHTTPServer(("127.0.0.1", 0), Model) as server:
            (codex_home / "config.toml").write_text(f"""
model = "gpt-5.2"
model_provider = "fixture"
developer_instructions = "{developer}"
check_for_update_on_startup = false
[windows]
sandbox = "unelevated"
[analytics]
enabled = false
[features]
code_mode = true
code_mode_only = true
multi_agent = true
multi_agent_v2 = true
multi_agent_v2_dynamic_tools = true
plugins = false
apps = false
[features.code_mode_host]
enabled = true
disable_in_process_fallback = true
[mcp_servers."account.docs"]
command = {json.dumps(sys.executable)}
args = {server_args(account_start)}
[projects.{json.dumps(str(repo))}]
trust_level = "trusted"
[model_providers.fixture]
name = "Release smoke test"
base_url = "http://127.0.0.1:{server.server_port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
""")
            worker = Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                result = subprocess.run(
                    [str(binary), "exec", "-c", "mcp_servers.docs.command=" + json.dumps(sys.executable),
                     "-c", "mcp_servers.docs.args=" + server_args(cli_start),
                     "--codeship-metadata-no-mcp", "--sandbox", "read-only",
                     "--ephemeral", "Read evidence.txt"], cwd=repo, env=env, capture_output=True,
                    stdin=subprocess.DEVNULL, text=True, timeout=100)
            finally:
                server.shutdown()
                worker.join()
        started = [p.name for p in (account_start, cli_start) if p.exists()]
        if started:
            raise RuntimeError(f"Metadata started configured MCP servers: {started}")
        if result.returncode or len(outputs) != 3 or marker not in json.dumps(outputs[1]) or marker in first_input:
            raise RuntimeError(f"Packaged repository read failed: {outputs}\n{result.stderr}")
        if personal in first_input or project not in first_input or developer not in first_input:
            raise RuntimeError("Metadata request included unexpected guidance or lost required instructions")
        if len(child_inputs) != 1 or child_prompt not in child_inputs[0] or personal in child_inputs[0]:
            raise RuntimeError(f"Expected a metadata child with scoped instructions: {outputs}")
        print(f"{binary}: verified parent and child metadata scope, MCP suppression and a read-only code-mode read")


if __name__ == "__main__":
    smoke(Path(sys.argv[1]).resolve())
