import { BrowserRouter, Route, Routes } from "react-router-dom";
import { HomePage } from "./pages/HomePage";
import { WatchPage } from "./pages/WatchPage";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/s/:roomId" element={<WatchPage />} />
      </Routes>
    </BrowserRouter>
  );
}
