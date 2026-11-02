import { a as CanvasKitError, i as loadRelease, o as errorMessage, r as CanvasHost, t as canvases } from "./chunks/canvas-kit-CWA9bM71.mjs";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { fileURLToPath } from "node:url";
//#region packages/canvas-kit/dist/extension.js
var toPath = (value) => typeof value === "string" ? value : fileURLToPath(value);
function toCanvasError(error) {
	if (error instanceof CanvasError) return error;
	if (error instanceof CanvasKitError) return new CanvasError(error.code, error.message);
	return new CanvasError("extension_error", errorMessage(error));
}
var guard = (run) => Promise.resolve().then(run).catch((error) => {
	throw toCanvasError(error);
});
/**
* Register a plugin's canvases with the current Copilot session, in one process.
* The kit's Vite build generates the extension entry that calls this; canvases do
* not call it directly.
*/
async function runCanvasExtension(canvases, options) {
	const entries = (Array.isArray(canvases) ? canvases : [canvases]).map((entry) => "kind" in entry ? {
		canvas: entry,
		page: void 0
	} : entry);
	const ids = /* @__PURE__ */ new Set();
	for (const { canvas } of entries) {
		if (ids.has(canvas.id)) throw new Error(`Two canvases in ${options.plugin.name} have the ID ${canvas.id}`);
		ids.add(canvas.id);
	}
	let session;
	const log = (message, level) => {
		if (!session) return;
		Promise.resolve(session.log(message, { level })).catch(() => {});
	};
	const { release, warning } = await loadRelease(toPath(options.releaseFile), options.plugin);
	let joined;
	const sessionReady = new Promise((resolve) => {
		joined = resolve;
	});
	const hosts = entries.map(({ canvas, page }) => new CanvasHost(canvas, {
		uiDir: toPath(options.uiDir),
		...page && { indexFile: page },
		release,
		log,
		session: sessionReady,
		sendToAgent: async (message) => {
			if (!session) throw new Error("The canvas has not joined a session yet");
			return session.send(message);
		}
	}));
	session = await joinSession({ canvases: hosts.map((host) => {
		const { canvas } = host;
		return createCanvas({
			id: canvas.id,
			displayName: canvas.title,
			description: canvas.description,
			...canvas.inputJsonSchema ? { inputSchema: canvas.inputJsonSchema } : {},
			actions: [...canvas.actions.values()].filter((action) => action.expose !== "ui").map((action) => ({
				name: action.name,
				description: action.description,
				inputSchema: action.inputJsonSchema,
				handler: (ctx) => guard(() => host.invoke({
					instanceId: ctx.instanceId,
					actionName: action.name,
					input: ctx.input,
					source: "agent"
				}))
			})),
			open: (ctx) => guard(() => host.open({
				instanceId: ctx.instanceId,
				input: ctx.input
			})),
			onClose: (ctx) => guard(() => host.closeInstance(ctx.instanceId))
		});
	}) });
	if (warning) log(warning, "warning");
	const joinedSession = session;
	joined({
		sessionId: joinedSession.sessionId,
		on: (handler) => joinedSession.on(handler),
		getEvents: () => joinedSession.getEvents()
	});
	const shutdown = () => {
		Promise.allSettled(hosts.map((host) => host.close())).finally(() => process.exit(0));
	};
	process.once("SIGTERM", shutdown);
	process.once("SIGINT", shutdown);
	return {
		session,
		hosts
	};
}
//#endregion
//#region \0canvas-kit:virtual:canvas-kit/extension/canvas-kit
await runCanvasExtension(canvases, {
	uiDir: new URL("./ui/", import.meta.url),
	releaseFile: new URL("../../release.json", import.meta.url),
	plugin: {
		"name": "canvas-kit",
		"version": "0.2.0"
	}
});
//#endregion
export {};
