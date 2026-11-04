import { Navigate, Route, Routes } from "react-router-dom";
import Intake from "@/pages/Intake";
import Workspace from "@/pages/Workspace";
import ResearchHome from "@/pages/ResearchHome";
import ResearchReport from "@/pages/ResearchReport";
import KbChat from "@/pages/KbChat";
import Pricing from "@/pages/Pricing";

export default function App() {
  return (
    <Routes>
      {/* The app opens on Chat */}
      <Route path="/" element={<Navigate to="/chat" replace />} />
      {/* Media workspace */}
      <Route path="/video" element={<Intake />} />
      <Route path="/v/:id" element={<Workspace />} />
      {/* Multi-agent research */}
      <Route path="/research" element={<ResearchHome />} />
      <Route path="/research/:id" element={<ResearchReport />} />
      {/* Chat (one route with an optional id, so switching chats doesn't remount the page) */}
      <Route path="/chat/:id?" element={<KbChat />} />
      {/* Subscription plans */}
      <Route path="/pricing" element={<Pricing />} />
      <Route path="*" element={<Navigate to="/chat" replace />} />
    </Routes>
  );
}
