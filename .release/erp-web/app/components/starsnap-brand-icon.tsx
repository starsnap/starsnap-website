import Image from 'next/image';

interface StarSnapBrandIconProps {
  className?: string;
}

export function StarSnapBrandIcon({ className }: StarSnapBrandIconProps) {
  const classes = className ? `star-brand-mark ${className}` : 'star-brand-mark';

  return (
    <span className={classes} aria-hidden="true">
      <Image
        src="/icon-96.png"
        alt=""
        width={96}
        height={96}
        loading="eager"
        unoptimized
        className="star-brand-image"
      />
    </span>
  );
}
