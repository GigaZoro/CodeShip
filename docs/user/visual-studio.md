# Visual Studio debugging

When CodeShip runs on Windows, agents can work with an app you debug in Visual
Studio 2022 or 2026. They can see why it stopped, with the exception, stack and
local variables. They can also press Continue for you, or start and stop
debugging. Visual Studio Code is not covered.

## Use it

Open your solution in Visual Studio. Start debugging, or let the agent start it,
and ask the agent to run your tests. A test run against a debugged app usually
stalls on the first exception break. Ask the agent to turn on auto-continue for
the run. CodeShip then presses Continue on every exception break and keeps a log
of each exception for the agent to read.

Auto-continue stops when debugging stops, when the agent turns it off, or after
its time limit (30 minutes unless the agent sets another). It also stops at the
first breakpoint, so the agent can inspect it. It never starts again on its own.

## Requirements

- Visual Studio and CodeShip must run at the same elevation. If you start
  Visual Studio as administrator, start CodeShip as administrator too.
- Exception details come from .NET code. JavaScript breaks show the location and
  stack only.

## Fewer breaks without an agent

Most breaks in ASP.NET apps are "exception user-unhandled": the exception left
your code and the framework handled it. In the Exception Settings window
(Ctrl+Alt+E), right-click **Common Language Runtime Exceptions** and choose
**Continue When Unhandled in User Code** to stop breaking on them. Agents then
see those exceptions only in logs, so leave the setting alone if you want
auto-continue to report them.
