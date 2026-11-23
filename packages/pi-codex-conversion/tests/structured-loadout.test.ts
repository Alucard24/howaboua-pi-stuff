import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import codexConversion from "../src/index.ts";

const native = ["read", "bash", "edit", "write"];
const structured = ["exec_command", "write_stdin", "apply_patch", "view_image"];

async function setup(t: TestContext, tools?: string[]) {
	const cwd = await mkdtemp(join(tmpdir(), "pcc-loadout-"));
	const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = cwd;
	let shutdown: (() => Promise<void>) | undefined;
	const errors: unknown[] = [];
	t.after(async () => {
		try {
			await shutdown?.();
			assert.deepEqual(errors, []);
		} finally {
			if (previousAgentDir === undefined)
				delete process.env["PI_CODING_AGENT_DIR"];
			else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
			await rm(cwd, { recursive: true, force: true });
		}
	});
	t.mock.method(
		globalThis,
		"fetch",
		async () => new Response(null, { status: 404 }),
	);
	await writeFile(
		join(cwd, "pi-codex-conversion.json"),
		JSON.stringify({
			executionMode: "normal",
			compaction: { method: "pi" },
			openai: { daybreak: false, cacheKeepalive: false },
			ui: { statusLine: false },
		}),
	);
	await writeFile(
		join(cwd, "auth.json"),
		JSON.stringify({
			"openai-codex": {
				type: "oauth",
				access: "fixture",
				refresh: "fixture",
				expires: Date.now() + 86_400_000,
				accountId: "test",
			},
			deepseek: { type: "api_key", key: "fixture" },
		}),
	);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(cwd, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const gpt = modelRuntime
		.getModels()
		.find(
			(model) =>
				model.provider === "openai-codex" && model.id === "gpt-6.2-sol",
		);
	const deepseek = modelRuntime
		.getModels()
		.find(
			(model) => model.provider === "deepseek" && model.id === "deepseek-flash",
		);
	assert.ok(gpt && deepseek);
	const settingsManager = SettingsManager.inMemory();
	let api: ExtensionAPI;
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: cwd,
		settingsManager,
		noExtensions: true,
		noContextFiles: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		extensionFactories: [
			codexConversion,
			(pi) => {
				api = pi;
				pi.registerTool({
					name: "test_external",
					label: "Test external tool",
					description: "Test external tool",
					defaultActive: false,
					parameters: { type: "object", properties: {} },
					async execute() {
						return {
							content: [{ type: "text", text: "fixture" }],
							details: {},
						};
					},
				});
			},
		],
	});
	await resourceLoader.reload();
	const { session, extensionsResult } = await createAgentSession({
		cwd,
		agentDir: cwd,
		model: deepseek,
		modelRuntime,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		...(tools ? { tools } : {}),
	});
	shutdown = async () => {
		try {
			await session.extensionRunner.emit({
				type: "session_shutdown",
				reason: "quit",
			});
		} finally {
			session.dispose();
		}
	};
	assert.deepEqual(extensionsResult.errors, []);
	await session.bindExtensions({
		mode: "print",
		onError: (error) => errors.push(error),
	});
	return {
		session,
		gpt,
		deepseek,
		selectTools: (names: string[]) => api.setActiveTools(names),
	};
}

function expectTools(
	pi: { getActiveToolNames(): string[] },
	expected: string[],
) {
	assert.deepEqual(pi.getActiveToolNames().sort(), [...expected].sort());
}

test("Structured reload keeps the admitted native loadout for other models", async (t) => {
	const { session, gpt, deepseek } = await setup(t);
	expectTools(session, native);
	await session.setModel(gpt);
	await session.setModel(deepseek);
	expectTools(session, native);
	for (let i = 0; i < 2; i++) {
		await session.setModel(gpt);
		await session.reload();
		await session.setModel(deepseek);
		expectTools(session, native);
	}
});

test("reload does not turn a registered tool into an admitted tool", async (t) => {
	const { session, gpt, deepseek, selectTools } = await setup(t);
	selectTools(["read", "test_external"]);
	await session.setModel(gpt);
	await session.reload();
	await session.setModel(deepseek);
	expectTools(session, ["read", "test_external"]);
	await session.setModel(gpt);
	selectTools(
		session.getActiveToolNames().filter((name) => name !== "test_external"),
	);
	await session.reload();
	await session.setModel(deepseek);
	expectTools(session, ["read"]);
});

test("reload respects a restrictive Pi tool allowlist", async (t) => {
	const { session, gpt, deepseek } = await setup(t, ["read", ...structured]);
	await session.setModel(gpt);
	await session.reload();
	await session.setModel(deepseek);
	expectTools(session, ["read"]);
});

test("changes to native tool admission while on Codex survive reload", async (t) => {
	const { session, gpt, deepseek, selectTools } = await setup(t);
	await session.setModel(gpt);
	// Replacing the loadout on Codex must be able to withdraw even tools
	// whose declarations the adapter is currently hiding from the model.
	selectTools(session.getActiveToolNames().filter((name) => name !== "write"));
	await session.reload();
	await session.setModel(deepseek);
	expectTools(session, ["read", "bash", "edit"]);
});
