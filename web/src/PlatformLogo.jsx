import React from 'react';

// Official brand icons, inlined as SVG so they render offline and survive the
// Docker build (no hotlinking a CDN). Path data is the official mark from the
// Simple Icons registry (Zendesk) and Vector Logo Zone (Freshdesk).
// Each icon is a full-bleed square that fills its chip; the chip clips corners.
const ICONS = {
  zendesk: (
    <svg viewBox="0 0 24 24" role="img" aria-label="Zendesk">
      <rect width="24" height="24" rx="5" fill="#03363D" />
      <g transform="translate(3.6 3.6) scale(0.7)">
        <path fill="#fff" d="M12.914 2.904V16.29L24 2.905H12.914zM0 2.906C0 5.966 2.483 8.45 5.543 8.45s5.542-2.484 5.543-5.544H0zm11.086 4.807L0 21.096h11.086V7.713zm7.37 7.84c-3.063 0-5.542 2.48-5.542 5.543H24c0-3.06-2.48-5.543-5.543-5.543z" />
      </g>
    </svg>
  ),
  freshdesk: (
    <svg viewBox="0 0 64 64" role="img" aria-label="Freshdesk">
      <path fill="#25c16f" d="M31.9 0h24.036A8 8 0 0 1 64 8.073V32.1C64 49.722 49.722 64 32.1 64h-.182A31.89 31.89 0 0 1 0 32.109C0 14.437 14.254.182 31.9 0z" />
      <path fill="#fff" d="M31.9 14.255c-8.093 0-14.654 6.56-14.654 14.654v9.964c.058 2.667 2.206 4.815 4.873 4.873h4.145V32.3h-5.6v-3.2c.34-6.026 5.327-10.74 11.364-10.74S43.04 23.065 43.38 29.1v3.2H37.7v11.454h3.745v.182c-.04 2.474-2.035 4.47-4.5 4.5h-4.473c-.364 0-.764.182-.764.545a.8.8 0 0 0 .764.764h4.5c3.205-.02 5.798-2.613 5.818-5.818v-.364a4.8 4.8 0 0 0 3.745-4.727V29.1c.182-8.254-6.364-14.836-14.654-14.836z" />
    </svg>
  ),
};

// Renders the official icon when we have one; otherwise a 2-letter monogram
// (jira, servicenow, freshservice, …) styled by the chip's brand-color class.
export default function PlatformLogo({ platform }) {
  return ICONS[platform] || <span>{(platform || '?').slice(0, 2).toUpperCase()}</span>;
}
