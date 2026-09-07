# Static assets

## logo.png

Drop the Bonsai logo here as `logo.png` and it replaces the built-in mark
everywhere — menu bar, connection screen, new-project screen — with no code
change. `Logo.tsx` probes for this file at startup and prefers it when present.

**Any colour works.** The mark is rendered as a CSS mask, so only the image's
alpha channel matters: the shape is filled with the current text colour and
follows the theme. That is deliberate — the artwork is dark line work on
transparency, and drawn as a plain image on this dark UI it would be invisible.

Use a square PNG with a transparent background. 512×512 or larger is plenty.
