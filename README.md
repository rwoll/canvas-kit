<img src="docs/logo.png" alt="canvas-kit logo: a chat bubble opening a canvas panel with a checklist" width="96" align="right">

# canvas-kit has moved to [rwoll/mono-oss](https://github.com/rwoll/mono-oss)

> [!IMPORTANT]
> **This repository is archived and no longer updated.** canvas-kit now lives in
> [rwoll/mono-oss](https://github.com/rwoll/mono-oss/tree/main/packages/canvas-kit#readme),
> together with its Copilot plugins. Use the commands below to get the latest versions.

## Use canvas-kit

The npm packages keep their names; only the repository moved:

```sh
npm create @rwoll/canvas my-canvases -- --repository me/my-canvases --canvas board
```

See the [canvas-kit guide](https://github.com/rwoll/mono-oss/tree/main/packages/canvas-kit#readme) for the API.

## Install the Copilot plugins

The `canvas-kit` and `session-summary` plugins are now in the `rwoll` marketplace:

```sh
copilot plugin marketplace add rwoll/mono-oss#stable
copilot plugin install canvas-kit@rwoll
copilot plugin install session-summary@rwoll
```

If you installed them from this repository, remove the old copies first:

```sh
copilot plugin uninstall canvas-kit@canvas-kit
copilot plugin uninstall session-summary@canvas-kit
copilot plugin marketplace remove canvas-kit
```

## Report issues

Open issues in [rwoll/mono-oss](https://github.com/rwoll/mono-oss/issues).
