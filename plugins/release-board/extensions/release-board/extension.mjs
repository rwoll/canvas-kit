import { a as CanvasKitError, i as loadRelease, o as errorMessage, r as CanvasHost, t as canvas_entry_default } from "./chunks/canvas-entry-Dqp4cR5s.mjs";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { fileURLToPath } from "node:url";
//#region ../../packages/canvas-kit/dist/extension.js
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
* Register a canvas with the current Copilot session. The kit's Vite build
* generates the extension entry that calls this; canvases do not call it directly.
*/
async function runCanvasExtension(canvas, options) {
	let session;
	const log = (message, level) => {
		if (!session) return;
		Promise.resolve(session.log(message, { level })).catch(() => {});
	};
	const { release, warning } = await loadRelease(toPath(options.releaseFile), options.plugin);
	let joined;
	const host = new CanvasHost(canvas, {
		uiDir: toPath(options.uiDir),
		release,
		log,
		session: new Promise((resolve) => {
			joined = resolve;
		}),
		sendToAgent: async (message) => {
			if (!session) throw new Error("The canvas has not joined a session yet");
			return session.send(message);
		}
	});
	session = await joinSession({ canvases: [createCanvas({
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
	})] });
	if (warning) log(warning, "warning");
	const joinedSession = session;
	joined({
		sessionId: joinedSession.sessionId,
		on: (handler) => joinedSession.on(handler),
		getEvents: () => joinedSession.getEvents()
	});
	const shutdown = () => {
		host.close().finally(() => process.exit(0));
	};
	process.once("SIGTERM", shutdown);
	process.once("SIGINT", shutdown);
	return {
		session,
		host
	};
}
//#endregion
//#region \0virtual:canvas-kit/extension-entry
await runCanvasExtension(canvas_entry_default, {
	uiDir: new URL("./ui/", import.meta.url),
	releaseFile: new URL("../../release.json", import.meta.url),
	plugin: {
		"name": "release-board",
		"version": "0.4.1"
	}
});
//#endregion
export {};
