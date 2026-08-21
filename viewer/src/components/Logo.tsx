interface LogoProps {
  size?: number;
}

export function Logo({ size = 56 }: LogoProps) {
  return (
    <div className="logo-mark" style={{ width: size, height: size, fontSize: size * 0.5 }}>
      S
    </div>
  );
}
