export const SplitCard = ({
  title,
  description,
  leftHref,
  rightHref,
  leftLabel = "Python",
  rightLabel = "TypeScript",
  leftLogo = "/images/python-logo.svg",
  rightLogo = "/images/typescript-logo.svg",
  className,
}) => {
  return (
    <div className={`bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl flex flex-col overflow-hidden ${className || ""}`}>
      <div className="relative group overflow-hidden">
        <div className="w-full h-48 bg-gradient-to-br from-zinc-400 via-zinc-500 to-zinc-600 dark:from-zinc-600 dark:via-zinc-700 dark:to-zinc-800 group-hover:scale-105 group-hover:blur-lg transition-all duration-300 flex items-center justify-center">
          <span className="text-5xl font-bold text-white/30 select-none">{title}</span>
        </div>
        <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
          <div className="grid grid-cols-2 h-full">
            <a href={leftHref} className="flex items-center justify-center bg-black/20 hover:bg-black/50 transition-colors duration-200" aria-label={leftLabel}>
              <img noZoom src={leftLogo} alt={leftLabel} className="h-10 w-10" />
            </a>
            <a href={rightHref} className="flex items-center justify-center bg-black/20 hover:bg-black/50 transition-colors duration-200" aria-label={rightLabel}>
              <img noZoom src={rightLogo} alt={rightLabel} className="h-10 w-10" />
            </a>
          </div>
        </div>
      </div>
      <div className="p-4 flex-grow flex flex-col">
        <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
        <p className="text-zinc-600 dark:text-zinc-400 text-sm mt-1 flex-grow">{description}</p>
        <div className="mt-4 pt-3 border-t border-zinc-100 dark:border-zinc-800 flex items-center justify-between text-sm">
          <a href={leftHref} className="flex items-center text-zinc-500 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white group/link transition-colors duration-200">
            <img noZoom src={leftLogo} alt={leftLabel} className="h-5 w-5 mr-2 filter grayscale group-hover/link:grayscale-0 transition-all duration-200" />
            <span>{leftLabel}</span>
          </a>
          <a href={rightHref} className="flex items-center text-zinc-500 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white group/link transition-colors duration-200">
            <img noZoom src={rightLogo} alt={rightLabel} className="h-5 w-5 mr-2 filter grayscale group-hover/link:grayscale-0 transition-all duration-200" />
            <span>{rightLabel}</span>
          </a>
        </div>
      </div>
    </div>
  );
};
