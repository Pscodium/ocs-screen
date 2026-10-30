import { BrowserRouter, Route, Routes } from "react-router-dom";
import { HomePage } from "./pages/HomePage";
import { PrivacyPage } from "./pages/PrivacyPage";
import { WatchPage } from "./pages/WatchPage";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/s/:roomId" element={<WatchPage />} />
        <Route path="/privacidade" element={<PrivacyPage />} />
      </Routes>
    </BrowserRouter>
  );
}
