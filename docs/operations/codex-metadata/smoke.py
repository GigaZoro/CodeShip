"""Exercise the packaged metadata runtime and its code-mode host against a loopback model."""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
from threading import Thread


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
        command = "Get-Content evidence.txt" if windows else "cat evidence.txt"
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
                if not outputs:
                    first_input = json.dumps(request["input"])
                    item = {"type": "custom_tool_call", "name": "exec", "call_id": "read", "input": code}
                    if any(t.get("type") == "namespace" and t.get("name") == "functions"
                           and any(c.get("name") == "exec" for c in t["tools"]) for t in request["tools"]):
                        item["namespace"] = "functions"
                else:
                    item = {"type": "message", "id": "reply", "role": "assistant",
                            "content": [{"type": "output_text", "text": "repository read complete"}]}
                outputs.append([i for i in request["input"] if i.get("type") == "custom_tool_call_output"])
                response = {"id": "r" + str(len(outputs))}
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
        if result.returncode or len(outputs) != 2 or marker not in json.dumps(outputs[1]) or marker in first_input:
            raise RuntimeError(f"Packaged repository read failed: {outputs}\n{result.stderr}")
        if personal in first_input or project not in first_input or developer not in first_input:
            raise RuntimeError("Metadata request included unexpected guidance or lost required instructions")
        print(f"{binary}: verified metadata instruction scope, MCP suppression and a read-only code-mode read")


if __name__ == "__main__":
    smoke(Path(sys.argv[1]).resolve())
