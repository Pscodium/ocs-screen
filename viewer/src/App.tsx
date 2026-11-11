import { BrowserRouter, Route, Routes } from "react-router-dom";
import { UpdateToast } from "./components/UpdateToast";
import { AdminPage } from "./pages/AdminPage";
import { HomePage } from "./pages/HomePage";
import { PrivacyPage } from "./pages/PrivacyPage";
import { WatchPage } from "./pages/WatchPage";

export function App() {
  return (
    <BrowserRouter>
      <UpdateToast />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/s/:roomId" element={<WatchPage />} />
        <Route path="/privacidade" element={<PrivacyPage />} />
        <Route path="/admin" element={<AdminPage />} />
      </Routes>
    </BrowserRouter>
  );
}
