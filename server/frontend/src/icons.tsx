//a plain png icon from frontend/public, rendered to fit its box
export function IconImg({ src, className = "w-4 h-4" }: { src: string; className?: string }) {
  return <img src={src} alt="" aria-hidden="true" className={`${className} object-contain`} />;
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
