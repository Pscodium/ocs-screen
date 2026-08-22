interface LogoProps {
  size?: number;
}

export function Logo({ size = 56 }: LogoProps) {
  return <img src="/icon.png" alt="" className="logo-mark" style={{ width: size, height: size }} />;
}
