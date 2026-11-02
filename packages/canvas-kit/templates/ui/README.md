# Shared UI

React components and the theme shared by every canvas in this project. Change
the brand once in `theme.css`, and add components here when two canvases need the
same UI.

```tsx
// canvases/<name>/App.tsx
import { Checklist, Header, Markdown, TextButton } from '../../ui'
import '../../ui/theme.css'

<Markdown label="Notes">{state.notes}</Markdown>   // Markdown the agent writes, safely
```

`canvas-kit new` uses it in every new canvas.
