// Tests for resource-agent without an agent or a model: acpx and opencode are replaced by fakes from this folder.
// Each test runs the script in a temporary project with its own config, so real
// .opencode/resources*.jsonc files and conversation state are not touched.
"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const SCRIPT = path.join(__dirname, "..", "bin", "resource-agent");
const FAKE_ACPX = path.join(__dirname, "fake-acpx");
const FAKE_OPENCODE = path.join(__dirname, "fake-opencode");

// The "Émile" alias checks that aliases are matched case-insensitively beyond ASCII.
const SHARED = `{
  // a comment at the start
  "version": 1,
  "options": { "wait": 5, "timeout": 60, "ttl": 5 }, /* and a block one */
  "resources": {
    "backend": {
      "description": "Backend // not a comment",
      "aliases": ["back", "Émile"],
      "tags": ["counter", " /click "],
      "location": { "type": "local", "path": "../back", "model": "fake/model" }
    },
    "frontend": {
      "aliases": ["front"],
      "tags": ["counter"],
      "location": { "type": "local", "path": "../front" }
    }
  }
}`;

function makeProject({ shared = SHARED, local } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agent-test-"));
  const project = path.join(base, "project");
  const fake = path.join(base, "fake");
  const home = path.join(base, "home");
  for (const dir of [path.join(project, ".opencode"), path.join(base, "back"), path.join(base, "front"), fake, home]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(project, ".opencode", "resources.jsonc"), shared);
  if (local !== undefined) fs.writeFileSync(path.join(project, ".opencode", "resources.local.jsonc"), local);

  const env = (extra) => ({
    PATH: process.env.PATH,
    HOME: home,
    ACPX_BIN: FAKE_ACPX,
    OPENCODE_BIN: FAKE_OPENCODE,
    FAKE_ACPX_DIR: fake,
    ...extra,
  });
  const argv = (args) => [SCRIPT, ...args];
  return {
    base,
    project,
    fake,
    home,
    back: fs.realpathSync(path.join(base, "back")),
    run(args, { env: extra = {}, input, cwd = project } = {}) {
      const result = spawnSync(process.execPath, argv(args), { cwd, env: env(extra), input, encoding: "utf8" });
      return { code: result.status, stdout: result.stdout, stderr: result.stderr };
    },
    runAsync(args, { env: extra = {} } = {}) {
      return new Promise((resolve) => {
        const child = spawn(process.execPath, argv(args), { cwd: project, env: env(extra) });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
    },
    calls() {
      const file = path.join(fake, "calls.jsonl");
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    },
    record(name) {
      return JSON.parse(fs.readFileSync(path.join(fake, "records", `${name.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`), "utf8"));
    },
    cleanup() {
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

// The acpx command after the global flags: ["sessions", "show", …], ["prompt", …] and so on.
function commandOf(call) {
  const withValue = new Set(["--cwd", "--agent", "--format", "--timeout", "--ttl", "--model"]);
  let i = 0;
  while (i < call.args.length && call.args[i].startsWith("--")) i += withValue.has(call.args[i]) ? 2 : 1;
  return call.args.slice(i);
}

const valueOf = (call, name) => {
  const at = call.args.indexOf(name);
  return at === -1 ? undefined : call.args[at + 1];
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("config: JSONC comments and the personal file on top of the shared one", (t) => {
  const project = makeProject({ local: `{ "resources": { "backend": { "location": { "path": "../front" } } } }` });
  t.after(() => project.cleanup());

  const listed = project.run(["resources", "--json"]);
  assert.equal(listed.code, 0, listed.stderr);
  const backend = JSON.parse(listed.stdout).find((r) => r.name === "backend");
  assert.equal(backend.description, "Backend // not a comment");
  // the same topic on two resources is not an error, unlike an alias
  assert.deepEqual(backend.tags, ["counter", "/click"]);
  assert.match(project.run(["resources"]).stdout, /^ {2}topics: counter, \/click$/m);
  // a resource is not addressed by a topic
  assert.match(project.run(["counter", "question"]).stderr, /unknown resource "counter"/);

  const profile = project.run(["profile", "émile"]);
  assert.equal(profile.code, 0, profile.stderr);
  assert.match(profile.stdout, new RegExp(`Folder: ${fs.realpathSync(path.join(project.base, "front"))}\\n`));
});

test("the project is the nearest folder above with a resources config", (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());

  const sub = path.join(project.project, "docs", "specs");
  fs.mkdirSync(sub, { recursive: true });
  const listed = project.run(["resources", "--json"], { cwd: sub });
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout).map((r) => r.name), ["backend", "frontend"]);
  // resource paths are relative to the project root, not to the current folder
  const profile = project.run(["profile", "backend"], { cwd: sub });
  assert.match(profile.stdout, new RegExp(`Folder: ${project.back}\\n`));
  // conversation state is in the project root too
  assert.equal(project.run(["backend", "question"], { cwd: sub, env: { RESOURCE_AGENT_CHAT: "chat1" } }).code, 0);
  assert.ok(fs.existsSync(path.join(project.project, ".opencode", ".state", "resource-agent_backend_chat1")));
  assert.ok(!fs.existsSync(path.join(sub, ".opencode")));

  const outside = project.run(["resources"], { cwd: project.home });
  assert.equal(outside.code, 2);
  assert.match(outside.stderr, /no \.opencode\/resources\.jsonc in .* or any folder above/);
});

test("config: clear errors", (t) => {
  const cases = [
    [SHARED.replace('"version": 1', '"version": 2'), "version"],
    [SHARED.replace('"type": "local", "path": "../back"', '"type": "ssh", "path": "../back"'), "unknown transport"],
    [SHARED.replace('"aliases": ["front"]', '"aliases": ["back"]'), "already taken by resource backend"],
    [SHARED.replace('"tags": ["counter"]', '"tags": "counter"'), "frontend.tags: expected an array"],
    [SHARED.replace('"tags": ["counter"]', '"tags": ["counter", " "]'), "frontend.tags: expected non-empty strings"],
    [SHARED.replace('"model": "fake/model"', '"model": "fake/model", "permission": { "bash": "ask" }'), '"ask" is not supported'],
    [SHARED.replace('"frontend": {', '"Front": {'), "may only contain"],
    [SHARED.replace('"frontend": {', '"status": {'), "clashes with a script command"],
  ];
  for (const [shared, expected] of cases) {
    const project = makeProject({ shared });
    t.after(() => project.cleanup());
    const result = project.run(["backend", "question"]);
    assert.equal(result.code, 2, `${expected}: ${result.stderr}`);
    assert.match(result.stderr, new RegExp(expected));
  }
});

test("question: acpx flags, permission profile and a cleaned environment", (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());

  const result = project.run(["back", "How", "are", "you?"], {
    env: { RESOURCE_AGENT_CHAT: "chat1", OPENCODE_SESSION_ID: "ses_parent", OPENCODE_PERMISSION: '{"edit":"allow"}' },
  });
  assert.equal(result.code, 0, result.stderr);
  const [source, answer] = result.stdout.trim().split("\n");
  assert.match(source, /^\[backend · local · plan · .* · not git · model fake\/model · new conversation\]$/);
  assert.equal(answer, "answer: How are you?");

  const calls = project.calls();
  assert.deepEqual(
    calls.map((call) => commandOf(call).slice(0, 2).join(" ")),
    ["sessions show", "sessions ensure", "sessions show", "set mode", "prompt -s"],
  );
  for (const call of calls) {
    assert.equal(valueOf(call, "--cwd"), project.back);
    assert.equal(valueOf(call, "--agent"), `${FAKE_OPENCODE} acp`);
    for (const flag of ["--no-fs", "--no-terminal", "--deny-all"]) assert.ok(call.args.includes(flag), flag);
    assert.equal(call.env.RESOURCE_AGENT_CHAT, undefined);
    assert.equal(call.env.OPENCODE_SESSION_ID, undefined);
    assert.equal(call.env.OPENCODE_PERMISSION, undefined);
    assert.equal(call.env.OPENCODE_DISABLE_AUTOUPDATE, "1");
  }
  // the model is passed only when the conversation is created
  assert.deepEqual(calls.map((call) => valueOf(call, "--model")), [undefined, "fake/model", undefined, undefined, undefined]);

  const prompt = calls.at(-1);
  assert.deepEqual(commandOf(prompt).slice(0, 3), ["prompt", "-s", "resource-agent:backend:chat1"]);
  assert.equal(valueOf(prompt, "--format"), "quiet");
  assert.equal(valueOf(prompt, "--timeout"), "60");
  assert.equal(valueOf(prompt, "--ttl"), "5");

  const profile = JSON.parse(prompt.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(profile.default_agent, "plan");
  assert.equal(profile.agent.plan.permission.edit, "deny");
  for (const permission of ["bash", "webfetch", "task", "external_directory", "question", "plan_exit", "plan_enter", "doom_loop"]) {
    assert.equal(profile.agent.plan.permission[permission], "deny", permission);
    assert.equal(profile.agent.build.permission[permission], "deny", permission);
  }
  assert.equal(profile.agent.plan.permission.read["*.env"], "deny");
  assert.equal(profile.agent.build.permission.edit["*"], "allow");
  for (const pattern of ["*AGENTS.md", "*CLAUDE.md", ".opencode/*", "*/.opencode/*", "*opencode.json", ".git/*"]) {
    assert.equal(profile.agent.build.permission.edit[pattern], "deny", pattern);
  }
  assert.ok(!JSON.stringify(profile).includes('"ask"'));
});

test("old ATLAS_* variables have no effect, but trigger a warning", (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());

  const result = project.run(["backend", "question"], { env: { ATLAS_CHAT: "old", ATLAS_WAIT: "1" } });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /ATLAS_CHAT has no effect: the variable was renamed to RESOURCE_AGENT_CHAT/);
  assert.match(result.stderr, /ATLAS_WAIT has no effect: the variable was renamed to RESOURCE_AGENT_WAIT/);
  const prompt = project.calls().find((call) => commandOf(call)[0] === "prompt");
  assert.equal(commandOf(prompt)[2], "resource-agent:backend:shared");
});

test("a long conversation history does not break a question", (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  // the conversation record is larger than 1 MB, the spawnSync default output limit
  const env = { RESOURCE_AGENT_CHAT: "chat1", FAKE_ACPX_HISTORY_BYTES: String(3 * 1024 * 1024) };

  assert.equal(project.run(["backend", "first"], { env }).code, 0);
  const second = project.run(["backend", "second"], { env });
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /answer: second/);
  assert.doesNotMatch(second.stdout, /new conversation/);
  const commands = project.calls().map((call) => commandOf(call).slice(0, 2).join(" "));
  assert.equal(commands.filter((c) => c === "sessions ensure").length, 1);
});

test("a follow-up question continues the conversation, the mode is set only when it changes", (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const env = { RESOURCE_AGENT_CHAT: "chat1" };

  assert.equal(project.run(["backend", "first"], { env }).code, 0);
  const second = project.run(["backend", "second"], { env });
  assert.equal(second.code, 0, second.stderr);
  assert.doesNotMatch(second.stdout, /new conversation/);

  const build = project.run(["backend", "--mode", "build", "third"], { env });
  assert.equal(build.code, 0, build.stderr);
  assert.match(build.stdout, /· build ·/);
  project.run(["backend", "--mode", "build", "fourth"], { env });

  const commands = project.calls().map((call) => commandOf(call).slice(0, 3).join(" "));
  assert.equal(commands.filter((c) => c.startsWith("sessions ensure")).length, 1);
  assert.deepEqual(
    commands.filter((c) => c.startsWith("set mode")),
    ["set mode plan", "set mode build"],
  );
  assert.equal(project.record("resource-agent:backend:chat1").acpx.desired_config_options.mode, "build");
});

test("conversations of different chats do not mix; a question from stdin", (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  assert.equal(project.run(["backend", "-"], { env: { RESOURCE_AGENT_CHAT: "chatA" }, input: "-question with a dash" }).code, 0);
  const other = project.run(["backend", "question"], { env: { RESOURCE_AGENT_CHAT: "chatB" } });
  assert.match(other.stdout, /new conversation/);
  const sessions = project.calls().filter((call) => commandOf(call)[0] === "prompt").map((call) => commandOf(call)[2]);
  assert.deepEqual(sessions, ["resource-agent:backend:chatA", "resource-agent:backend:chatB"]);
  assert.equal(project.run(["backend", "-question"]).code, 2);
});

test("a long question: code 75, busy 76, the answer via --wait", async (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const env = { RESOURCE_AGENT_CHAT: "chat1", FAKE_ACPX_SLOW_MS: "2500" };

  const asked = project.run(["backend", "SLOW question"], { env: { ...env, RESOURCE_AGENT_WAIT: "1" } });
  assert.equal(asked.code, 75, asked.stderr);
  assert.match(asked.stdout, /still working/);

  const busy = project.run(["backend", "another question"], { env });
  assert.equal(busy.code, 76, busy.stderr);
  assert.match(busy.stdout, /--wait/);

  const waited = project.run(["backend", "--wait"], { env: { ...env, RESOURCE_AGENT_WAIT: "10" } });
  assert.equal(waited.code, 0, waited.stderr);
  assert.match(waited.stdout, /answer: SLOW question/);
  assert.match(waited.stdout, /new conversation/);

  const nothing = project.run(["backend", "--wait"], { env });
  assert.equal(nothing.code, 0);
  assert.match(nothing.stdout, /no questions in progress/);
  assert.equal(project.calls().filter((call) => commandOf(call)[0] === "prompt").length, 1);
});

test("--cancel stops a question", async (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const env = { RESOURCE_AGENT_CHAT: "chat1", FAKE_ACPX_SLOW_MS: "30000" };

  assert.equal(project.run(["backend", "SLOW long"], { env: { ...env, RESOURCE_AGENT_WAIT: "0" } }).code, 75);
  const started = Date.now();
  const cancelled = project.run(["backend", "--cancel"], { env });
  assert.equal(cancelled.code, 0, cancelled.stderr);
  assert.match(cancelled.stdout, /question cancelled/);
  assert.ok(Date.now() - started < 10_000, "cancelling took too long");
  assert.ok(project.calls().some((call) => commandOf(call)[0] === "cancel"));

  // the conversation is free: the next question goes out right away
  const next = project.run(["backend", "after cancel"], { env });
  assert.equal(next.code, 0, next.stderr);
});

test("two simultaneous questions: only one goes out", async (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const env = { RESOURCE_AGENT_CHAT: "chat1", RESOURCE_AGENT_WAIT: "0", FAKE_ACPX_SLOW_MS: "30000" };

  const results = await Promise.all([
    project.runAsync(["backend", "SLOW first"], { env }),
    project.runAsync(["backend", "SLOW second"], { env }),
  ]);
  assert.deepEqual(results.map((r) => r.code).sort(), [75, 76], JSON.stringify(results));
  // the acpx call is logged by the background process, which may show up slightly after the "still working" reply
  const prompts = () => project.calls().filter((call) => commandOf(call)[0] === "prompt").length;
  for (let i = 0; i < 50 && prompts() === 0; i++) await sleep(100);
  await sleep(300);
  assert.equal(prompts(), 1);
  assert.equal(project.run(["backend", "--cancel"], { env }).code, 0);
});

test("a broken-off question does not block the conversation", (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const job = path.join(project.project, ".opencode", ".state", "resource-agent_backend_chat1", "job");
  fs.mkdirSync(job, { recursive: true });
  fs.writeFileSync(path.join(job, "meta.json"), JSON.stringify({ pid: 2 ** 22 + 12345 }));

  const waited = project.run(["backend", "--wait"], { env: { RESOURCE_AGENT_CHAT: "chat1" } });
  assert.equal(waited.code, 1);
  assert.match(waited.stderr, /broke off/);

  fs.mkdirSync(job, { recursive: true });
  fs.writeFileSync(path.join(job, "meta.json"), JSON.stringify({ pid: 2 ** 22 + 12345 }));
  const asked = project.run(["backend", "new question"], { env: { RESOURCE_AGENT_CHAT: "chat1" } });
  assert.equal(asked.code, 0, asked.stderr);
  assert.match(asked.stderr, /broke off/);
});

test("changed permissions restart the agent process, unchanged ones do not", async (t) => {
  const project = makeProject({ local: "{}" });
  t.after(() => project.cleanup());
  const env = { RESOURCE_AGENT_CHAT: "chat1" };
  assert.equal(project.run(["backend", "first"], { env }).code, 0);
  const recordId = project.record("resource-agent:backend:chat1").acpxRecordId;

  // a fake acpx queue owner and its lock file
  const startOwner = () => {
    const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "__queue-owner"], { detached: true, stdio: "ignore" });
    owner.unref();
    const queues = path.join(project.home, ".acpx", "queues");
    fs.mkdirSync(queues, { recursive: true });
    fs.writeFileSync(path.join(queues, "owner.lock"), JSON.stringify({ pid: owner.pid, sessionId: recordId }));
    t.after(() => {
      try {
        process.kill(owner.pid, "SIGKILL");
      } catch {}
    });
    return owner.pid;
  };

  const unchanged = startOwner();
  assert.equal(project.run(["backend", "second"], { env }).code, 0);
  assert.ok(isAlive(unchanged), "the profile did not change, but the process was stopped");

  fs.writeFileSync(
    path.join(project.project, ".opencode", "resources.local.jsonc"),
    `{ "resources": { "backend": { "location": { "permission": { "jira_*": "deny" } } } } }`,
  );
  const result = project.run(["backend", "third"], { env });
  assert.equal(result.code, 0, result.stderr);
  await sleep(200);
  assert.ok(!isAlive(unchanged), "the profile changed, but the agent process was not stopped");
  const profile = JSON.parse(project.calls().at(-1).env.OPENCODE_CONFIG_CONTENT);
  assert.equal(profile.agent.plan.permission["jira_*"], "deny");
});

test("without a model: a warning and a conversation created without --model", (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const result = project.run(["front", "question"], { env: { RESOURCE_AGENT_CHAT: "chat1" } });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /no model set/);
  const ensure = project.calls().find((call) => commandOf(call)[1] === "ensure");
  assert.equal(valueOf(ensure, "--model"), undefined);
});

test("agent errors: permission denial and OpenCode 2.x", (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const denied = project.run(["backend", "DENIED"], { env: { RESOURCE_AGENT_CHAT: "chat1" } });
  assert.equal(denied.code, 5);
  assert.match(denied.stderr, /permissions forbid/);
  assert.doesNotMatch(denied.stderr, /tokens:/);

  const v2 = project.run(["backend", "question"], { env: { RESOURCE_AGENT_CHAT: "chat2", FAKE_OPENCODE_VERSION: "2.0.24" } });
  assert.equal(v2.code, 1);
  assert.match(v2.stderr, /targets 1\.x/);
});

test("--new starts the conversation over; an unknown resource and an empty question", (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const env = { RESOURCE_AGENT_CHAT: "chat1" };
  assert.equal(project.run(["backend", "first"], { env }).code, 0);
  const fresh = project.run(["backend", "--new"], { env });
  assert.equal(fresh.code, 0, fresh.stderr);
  assert.match(fresh.stdout, /new conversation/);
  assert.ok(project.calls().some((call) => commandOf(call)[1] === "new"));

  const unknown = project.run(["qa", "question"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown resource "qa"/);
  assert.equal(project.run(["backend"]).code, 2);
});

test("init in a new project creates empty templates in the git root and .gitignore lines", (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "agent-init-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/");
  const sub = path.join(repo, "docs");
  fs.mkdirSync(sub);
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: sub, encoding: "utf8" });

  const first = run(["init"]);
  assert.equal(first.status, 0, first.stderr);
  for (const name of ["resources.jsonc", "resources.local.example.jsonc", "resources.local.jsonc"]) {
    assert.ok(fs.existsSync(path.join(repo, ".opencode", name)), name);
  }
  assert.equal(
    fs.readFileSync(path.join(repo, ".gitignore"), "utf8"),
    "node_modules/\n# personal resource settings and resource-agent state\n.opencode/resources.local.jsonc\n.opencode/.state/\n",
  );
  // the template is a working config with an empty resource list
  const listed = run(["resources", "--json"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout), []);

  // running it again overwrites and duplicates nothing
  fs.writeFileSync(path.join(repo, ".opencode", "resources.jsonc"), '{ "version": 1, "resources": {} }\n');
  const second = run(["init"]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /already exists/);
  assert.doesNotMatch(second.stdout, /created|added/);
  assert.equal(fs.readFileSync(path.join(repo, ".opencode", "resources.jsonc"), "utf8"), '{ "version": 1, "resources": {} }\n');
});

test("init creates the personal file from the template and does not overwrite it", (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const example = path.join(project.project, ".opencode", "resources.local.example.jsonc");
  const local = path.join(project.project, ".opencode", "resources.local.jsonc");
  fs.writeFileSync(example, "// template\n{}\n");
  assert.equal(project.run(["init"]).code, 0);
  assert.equal(fs.readFileSync(local, "utf8"), "// template\n{}\n");
  fs.writeFileSync(local, "{}\n");
  assert.match(project.run(["init"]).stdout, /already exists/);
  assert.equal(fs.readFileSync(local, "utf8"), "{}\n");
});
