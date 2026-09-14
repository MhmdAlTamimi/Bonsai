import type { JSX } from 'react';

/** The supplied vector, shared with the favicon. A mask follows the app theme. */
export function Logo({
  size = 28,
  title = 'Bonsai',
}: {
  size?: number;
  title?: string;
}): JSX.Element {
  return (
    <span
      className="logo"
      role="img"
      aria-label={title}
      title={title}
      style={{
        width: size,
        height: size,
        WebkitMaskImage: 'url(/bonsai.svg)',
        maskImage: 'url(/bonsai.svg)',
      }}
    />
  );
}
