//a plain png icon from frontend/public, rendered to fit its box
export function IconImg({ src, className = "w-4 h-4" }: { src: string; className?: string }) {
  return <img src={src} alt="" aria-hidden="true" className={`${className} object-contain`} />;
}

//little node-link glyph for the "arrange by relationships" control. drawn inline so it's crisp at any
//size and tints with the surrounding text colour, set apart from the grid icon by showing linked nodes.
export function NetworkIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
         className={`${className} object-contain`}>
      <line x1="12" y1="12" x2="5" y2="5" />
      <line x1="12" y1="12" x2="19" y2="6" />
      <line x1="12" y1="12" x2="6" y2="19" />
      <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
      <circle cx="5" cy="5" r="2" />
      <circle cx="19" cy="6" r="2" />
      <circle cx="6" cy="19" r="2" />
    </svg>
  );
}

//the delete affordance: the user's grey bin by default, crossfading to the red bin on hover. drop both
//pngs in frontend/public (grey_trashbin.png and red_trashbin.png). put `group/trash` on the button so
//hovering anywhere on it does the swap.
export function TrashImg({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <span className={`relative inline-block ${className}`}>
      <img src="/grey_trashbin.png" alt="delete"
           className="absolute inset-0 h-full w-full object-contain transition-opacity duration-150 group-hover/trash:opacity-0" />
      <img src="/red_trashbin.png" alt="" aria-hidden="true"
           className="absolute inset-0 h-full w-full object-contain opacity-0 transition-opacity duration-150 group-hover/trash:opacity-100" />
    </span>
  );
}
