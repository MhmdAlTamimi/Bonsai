import { type JSX, useEffect, useState } from 'react';

/**
 * The Bonsai mark.
 *
 * Rendered as a MASK filled with `currentColor`, not as an image. The artwork
 * is dark line work on transparency and this UI is dark, so drawn as an image
 * it would be all but invisible; as a mask its alpha channel becomes the shape
 * and the theme decides the colour, which works on any background and follows
 * the text colour wherever the mark is placed.
 *
 * A file at /logo.png overrides the built-in vector automatically, so replacing
 * the mark is dropping one file into packages/ui/public — no code change.
 */
const CUSTOM_LOGO = '/logo.png';

export function Logo({ size = 22, title = 'Bonsai' }: { size?: number; title?: string }): JSX.Element {
  const [custom, setCustom] = useState(false);

  useEffect(() => {
    // Probe rather than assume: a missing mask renders nothing at all, which
    // would silently leave a hole where the logo should be.
    const image = new Image();
    image.onload = () => setCustom(true);
    image.src = CUSTOM_LOGO;
  }, []);

  return (
    <span
      className="logo"
      role="img"
      aria-label={title}
      title={title}
      style={{
        width: size,
        height: size,
        ...(custom
          ? {
              WebkitMaskImage: `url(${CUSTOM_LOGO})`,
              maskImage: `url(${CUSTOM_LOGO})`,
            }
          : {
              WebkitMaskImage: `url("${BUILT_IN}")`,
              maskImage: `url("${BUILT_IN}")`,
            }),
      }}
    />
  );
}

/**
 * PLACEHOLDER MARK — drawn here, not the real artwork.
 *
 * The intended logo could not be embedded: it arrived as an image in
 * conversation rather than a file, so there were no bytes to copy. This is a
 * line-art bonsai in the same single-weight style, sized to stay legible down
 * to 22px, standing in until the real file is dropped at
 * packages/ui/public/logo.png — which overrides it with no code change.
 */
export const BUILT_IN_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" stroke="#000" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round">
<path d="M24 34a12 12 0 0 1 14-15 14 14 0 0 1 25 4 10 10 0 0 1 8 12"/>
<path d="M24 34a11 11 0 0 0 12 12"/>
<path d="M71 35a9 9 0 0 1 11 12 9 9 0 0 1-12 5"/>
<path d="M50 86c-4-16 0-27 6-35s7-16 4-25"/>
<path d="M36 86c3-13-1-22-7-28"/>
<path d="M64 86c-2-13-8-21-14-25"/>
</svg>`;

const BUILT_IN = `data:image/svg+xml,${encodeURIComponent(BUILT_IN_LOGO_SVG)}`;
