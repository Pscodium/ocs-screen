import iconUrl from "../assets/icon.png";

interface LogoProps {
  size?: number;
}

export function Logo({ size = 48 }: LogoProps) {
  return <img src={iconUrl} alt="" className="logo-mark" style={{ width: size, height: size }} />;
}
