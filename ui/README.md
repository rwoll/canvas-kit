# @examples/ui

React components and the theme shared by every canvas in this marketplace. Change
the brand once in `theme.css`, and add components here when two canvases need the
same UI.

```tsx
// canvases/<name>/src/main.tsx
import '@rwoll/canvas-kit/styles.css'
import '@examples/ui/theme.css'

// canvases/<name>/src/App.tsx
import { Checklist, Header, Markdown, TextButton } from '@examples/ui'

<Markdown label="Notes">{state.notes}</Markdown>   // Markdown the agent writes, safely
```

`canvas-kit new` adds this package to every new canvas.
