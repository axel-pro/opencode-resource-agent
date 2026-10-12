# opencode-resource-agent

Lets an [OpenCode](https://opencode.ai) agent ask the agents of other repositories. A product is usually split
across several repositories — backend, frontend, QA — and each of them has its own agent that knows its code,
`AGENTS.md`, skills and MCP servers. An agent working in one repository cannot see the others, so instead of
guessing it asks the agent of the right repository. Such repositories are called **resources**.

The package has three parts:

- **CLI `resource-agent`** — the transport. Through [acpx](https://github.com/openclaw/acpx) (a command-line
  client for the ACP protocol) it starts a separate OpenCode in the resource's folder with restricted permissions,
  sends it the question and returns the answer. No model is involved in the transport itself.
- **OpenCode plugin** — the `resource_agent` tool, a wrapper over the CLI. Its description lists the configured
  resources, so the agent knows whom it can ask.
- **Skill `resource-agents`** — instructions for the asking agent: how to write a question, when to follow up,
  what to do while an answer is being prepared, and how to sum up. The plugin registers it automatically.

A conversation with a resource is bound to the OpenCode chat that asks. In a new chat the resource agent starts
from scratch; in a continued chat it remembers what it was asked, even if its process ended long ago.

## Installation

The package is not published to npm; npm installs it straight from GitHub, pinned to a release tag.
Add it to the `package.json` of the asking project and run `npm install`:

```json
{
  "devDependencies": {
    "opencode-resource-agent": "github:axel-pro/opencode-resource-agent#v0.2.1"
  }
}
```

Then add the plugin to `opencode.json` by path (relative to `opencode.json`):

```json
{
  "plugin": ["./node_modules/opencode-resource-agent"]
}
```

Create the config templates and check the environment:

```bash
npx resource-agent init     # creates .opencode/resources*.jsonc and .gitignore lines; overwrites nothing
npx resource-agent status   # every item should have a check mark
```

Requirements: Node.js 22.13+ in `PATH` and OpenCode 1.x (both for the asking project and for the resource agents).
Linux and macOS are supported; Windows has not been tested.

To update, change the tag and run `npm install` again, then restart OpenCode. Versions are listed on the
[Tags](https://github.com/axel-pro/opencode-resource-agent/tags) page.

## Config

`.opencode/resources.jsonc` is the shared file, committed to git. The format is JSONC (JSON with comments):

```jsonc
{
  "version": 1,
  "options": {
    "wait": 450,     // how long one call waits for an answer, s; if not ready, collect it with --wait
    "timeout": 3600, // overall limit per question, s
    "ttl": 1800      // how long the agent process waits for the next question, s; does not affect conversation memory
  },
  "resources": {
    "backend": {
      "description": "Counter backend (FastAPI): API, validation, state storage",
      "aliases": ["back", "bob"],               // other names of the resource; must be unique
      "tags": ["counter", "/click", "MAX_VALUE"], // topics showing that a question is for this resource
      "location": {
        "type": "local",          // transport: the agent runs on this machine
        "path": "../product/back", // local checkout, relative to the folder that contains .opencode/
        "model": "provider/model", // optional: the agent's model
        "effort": "high",          // optional: reasoning effort, default by default
        "permission": {}          // optional: OpenCode rules on top of the mode's profile
      }
    }
  }
}
```

`.opencode/resources.local.jsonc` is the personal file, not committed to git. It is merged on top of the shared
one: objects are merged, values are replaced, `null` removes a key. A `location` with another `type` replaces the
shared one whole: to run an `ssh` resource locally, give the full local `location`, and the shared `host` and `port`
do not get into it. The personal file usually sets the model (everyone has their own providers) and personal paths
to the repositories. `resource-agent init` creates it from the template
`.opencode/resources.local.example.jsonc`.

If no model is set, the resource's OpenCode silently uses its default model, which may be an external service.
`resource-agent` warns about it.

`effort` is the reasoning effort: one of the model's variants in OpenCode, usually `low`, `medium`, `high` and
`default` (the provider's own level). Without it the level is `default`: otherwise a new conversation would start
with the variant last chosen for this model in your own OpenCode. A level the model does not have is an error that
lists the available ones; for a model without variants `effort` is ignored with a warning.

### A resource on an agent server (`ssh`)

The `local` transport needs a checkout of the resource and runs its agent on your machine. The `ssh` transport sends
the question to an agent server instead: there the resource's agent runs next to its repository, and the server
sets the model, the provider and the permissions. Your machine needs only an OpenSSH client and a key the server
accepts.

```jsonc
"backend": {
  "description": "…", "aliases": ["back"], "tags": ["…"],
  "location": {
    "type": "ssh",
    "host": "agents.internal", // host name, address or a Host from ~/.ssh/config
    "port": 2222,              // optional; one server port is one repository
    "user": "agent"            // optional, agent by default
  }
}
```

- `path`, `model`, `effort` and `permission` are not allowed: the repository, the model, its reasoning effort and
  the permissions are on the server.
  If the personal file still sets them for this resource, remove them there with `null`.
- Only `plan` mode: the server's agent does not edit its repository.
- `options` (`wait`, `timeout`, `ttl`) and the `RESOURCE_AGENT_WAIT`, `RESOURCE_AGENT_TIMEOUT`, `RESOURCE_AGENT_TTL`
  variables do not apply: the agent server sets its own limits, and ssh does not pass environment variables to it.
  A long question still ends with code 75 and is collected with `--wait`, but how long a call waits is up to
  the server.
- ssh runs with `BatchMode=yes`: a password or an unknown host key is an error, not a prompt. See
  "First connection to an agent server" below.
- A question, `--wait`, `--cancel` and `--new` are commands of the `resource-agent/1` protocol: `ssh … resource-agent/1
  ask <chat>` with the question on stdin. The server keeps the conversations, so `--wait` works from any machine
  with the same chat id.
- There is no shared conversation: on a shared server, calls without a chat id from different people would land in
  one conversation. Outside OpenCode set `RESOURCE_AGENT_SESSION=<name>`; without it the call is refused with code 2.

#### First connection to an agent server

Two things have to be in place before the first question, and both are one-time steps of a person, not of the agent:

1. **The server lets you in.** Send your public key (`~/.ssh/id_ed25519.pub` or the key from your `~/.ssh/config`)
   to whoever runs the agent server; they add it to the instance's `authorized_keys`. Until then `status` shows
   `Permission denied (publickey)`.
2. **You trust the server.** ssh checks the server's host key against `~/.ssh/known_hosts`, and with `BatchMode`
   it cannot ask "Are you sure you want to continue connecting?". An unknown server is refused with
   `Host key verification failed.` (exit code 255). Add its key once:

   ```bash
   ssh-keyscan -p 2222 agents.internal 2>/dev/null | ssh-keygen -lf -     # look at the fingerprint first
   ssh-keyscan -p 2222 agents.internal 2>/dev/null >> ~/.ssh/known_hosts  # then trust it
   ```

   `ssh-keyscan` takes the key the server presents without checking it, so compare the fingerprint with the one
   the server's owner gives you (on the server: `ssh-keygen -lf <instance>/hostkeys/ssh_host_ed25519_key.pub`).
   For a port other than 22 the entry is written as `[agents.internal]:2222`. Use the same host name as in
   `location.host`: `localhost` and `127.0.0.1` are different entries for ssh.

If the server is recreated with a new host key, ssh refuses with `REMOTE HOST IDENTIFICATION HAS CHANGED`. Make
sure the change is expected, remove the old entry with `ssh-keygen -R '[agents.internal]:2222'` and add the new one
as above.

`resource-agent status` checks both: an ssh resource gets ✓ and the server's reply, or ✗ and the line ssh printed.

The config lives in `.opencode/`, but it does not depend on OpenCode as a client: `resource-agent` reads it both
when run from a terminal and from another agent. The script looks for the nearest folder with
`.opencode/resources.jsonc`, starting from the current one, so it works from any subfolder of the project.

## Asking

In OpenCode it is enough to ask the agent: "ask the backend which endpoints change the counter". The agent loads
the `resource-agents` skill and calls the `resource_agent` tool. From a terminal:

```bash
npx resource-agent backend 'Which endpoints change the counter value?'
npx resource-agent back - <<'Q'                    # a long question — through stdin
I am designing authorization. Is there a middleware layer that checks the token?
Q
npx resource-agent backend --mode build 'Add an X-Admin header check to /reset'
npx resource-agent backend --wait      # collect the answer to a long question
npx resource-agent backend --cancel    # cancel a question in progress
npx resource-agent backend --new       # start the conversation with the resource over
npx resource-agent status              # check the environment, resources and questions in progress
npx resource-agent profile backend     # what the resource agent gets: command, folder, permissions
```

From a terminal all calls go to the shared conversation `shared`; `RESOURCE_AGENT_SESSION=<name>` sets
a different conversation name; `ssh` resources have no shared conversation and need it. Inside OpenCode the plugin
binds the conversation to the chat, also for `resource-agent` run from the shell.

The first question of a conversation (a new one or one started over with `--new`) is preceded by rules for
the resource agent: it is answering another agent that cannot see the resource, so the answer should make sense
without internals, lead with the conclusion and mark assumptions. The rules are `ANSWER_RULES` in
`bin/resource-agent`.

The first line of an answer is its source: resource, transport, mode, path, branch and model, for example
`[backend · local · plan · /…/product/back · main · model provider/model]`.

**Long questions.** The script waits for an answer no longer than `wait` seconds (450 by default). The countdown
starts after the conversation is prepared — the agent is started, the mode and model are set — and preparation has
its own limit of 120 s. Together this is less than OpenCode's 10-minute shell command limit. If the agent has not
finished, the script exits with code 75 while the agent keeps working in the background. The answer is collected
with `--wait`. While a question is in progress, a new question to the same resource in the same conversation is not
sent: the script exits with code 76 and suggests `--wait` or `--cancel`.

Exit codes: `0` — answer received; `75` — the agent is still working; `76` — the conversation is busy with
a previous question; `2` — invalid invocation or config; `3`, `5`, `130` — acpx codes (timeout, permission denial,
interruption); `69` — the agent server is full (`ssh`); `255` — ssh could not reach the agent server.

Environment variables: `RESOURCE_AGENT_CHAT`, `RESOURCE_AGENT_SESSION` — whose conversation this is;
`RESOURCE_AGENT_WAIT`, `RESOURCE_AGENT_TIMEOUT`, `RESOURCE_AGENT_TTL` — override `options`, in seconds (`local` only);
`ACPX_BIN`, `OPENCODE_BIN`, `SSH_BIN` — program paths.

## Modes and permissions

The resource agent works with the permissions of a profile that `resource-agent` passes to its OpenCode through
`OPENCODE_CONFIG_CONTENT`. The profile is applied on top of the resource's own `opencode.json`, and the resource
cannot weaken it.

| | `plan` (default) | `build` |
|---|---|---|
| Read code | yes, except `.env` (`.env.example` is allowed) | same |
| Edit files | no | yes, except `opencode.json`, `.opencode/`, `.git/`, `AGENTS.md`, `CLAUDE.md` |
| Shell, internet, own subagents, files outside the repository | no | no |
| The resource's MCP servers and own tools | yes | yes |

- Editing the resource's configs is closed in `build` too: otherwise the agent could change its plugin, and on
  the next start that plugin would run without restrictions.
- **The resource's MCP servers run with your credentials, even in `plan`.** If some of them write (for example,
  create issues in a tracker), or the resource has its own tool that reaches further, close them in
  `location.permission`: `{"jira_*": "deny"}`.
- The `ask` value in `permission` is not supported: there is nobody to confirm. acpx runs with `--deny-all`
  and would reject such a request, and then exit with an error even if the answer was ready.
- If `permission` or the model changes, the agent process restarts with the new settings on the next question,
  and the conversation continues.
- Shell is forbidden to the resource agent in `build`, so it cannot run tests in its repository.

## Adding a resource

Add an entry to `resources` in the shared file: a name (`a-z`, `0-9`, `-`), a description (the asking agent decides
whom to ask by it), aliases, topics and `location`.

Aliases and topics answer different questions. An alias is another name of the resource: `resource-agent bob …`
is the same as `resource-agent backend …`, so aliases are unique. Topics (`tags`) are terms by which the asking agent
understands that a question is for this resource: internal names of services, endpoints, tables, features.
The model understands general words like "API" from the description; the useful topics are terms that cannot be
guessed from it. One topic may belong to several resources — then the agent asks each of them. A resource is not
addressed by a topic.

Then restart OpenCode: the resource list in the `resource_agent` tool description is built at startup.

## Adding a transport

A transport is a way to deliver a question to a resource agent, the `location.type` key. Transports are described
in the `TRANSPORTS` table in `bin/resource-agent`. Each transport says whether it supports `build`, validates its
settings and, for a resource, returns:

- the command acpx starts as the agent;
- the session folder;
- the agent's environment variables;
- the address and checkout details for the source line.

Asking, waiting, cancelling and resetting a conversation are shared by all acpx-based transports. A transport
that does not run acpx on this machine, like `ssh`, defines instead `send` (performs an action and returns
the exit code), `check` (a line for `status`) and `describe` (lines for `profile`).

## State and disk space

- `.opencode/.state/` — `resource-agent` state: questions in progress and permission fingerprints. Not committed
  to git (`resource-agent init` adds it to `.gitignore`).
- acpx conversation records live in `~/.acpx/sessions`, the resource's OpenCode sessions in OpenCode's storage.
  They are not removed automatically. To free space:
  ```bash
  npx acpx sessions prune --older-than 30 --include-history   # closed acpx conversations
  cd <resource folder> && opencode session list                # then opencode session delete <id>
  ```

## Limitations

- On the first start in another repository, OpenCode writes its service files into that repository's `.opencode/`.
- The package targets OpenCode 1.x (`engines.opencode` in `package.json`): plugins are written in a different format
  in 2.x, so the tool is not available there. The CLI still works from a terminal, but it does not start a resource
  agent on OpenCode 2.x: the permission profile is written for 1.x and would not apply.
- `resource-agent` restarts an agent through an internal acpx 0.19.4 file (`~/.acpx/queues/*.lock`), which is why
  acpx is pinned to that exact version. If the format changes after an acpx update, new permissions take effect
  when the agent exits on its own (after `ttl`).

## Development

```bash
npm install
npm test
```

Tests run the CLI in temporary projects against fake `acpx`, `opencode` and `ssh` (`test/fake-acpx`,
`test/fake-opencode`, `test/fake-ssh`), so no agent, model or agent server is needed.

To try a local checkout in OpenCode, point the plugin at the directory:

```json
{ "plugin": ["../opencode-resource-agent"] }
```

## Releasing

A release is a `vX.Y.Z` git tag: users pin it in their `package.json`.

```bash
npm version patch   # or minor / major: updates package.json and creates the vX.Y.Z tag
git push --follow-tags
```

GitHub Actions (`.github/workflows/ci.yml`) runs the tests on Node.js 22 and 24 on every push to `main`
and on pull requests. There is no release workflow: the tag itself is the release.

## License

[MIT](LICENSE)
