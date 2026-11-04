import { ArrowUpRight, Code2, Lightbulb, PenLine, Sprout } from "lucide-react";
import FinesseMark from "@/components/FinesseMark";

const STARTERS = [
  { icon: PenLine, title: "Find the right words", description: "A first draft, a fresh perspective", prompt: "Help me write something. Ask me what I'm working on, who it's for, and the tone I'd like.", color: "peach" },
  { icon: Lightbulb, title: "Untangle an idea", description: "Make the complex feel simple", prompt: "I'd like to understand a complex idea. Ask me what topic I'm curious about and explain it using everyday examples.", color: "gold" },
  { icon: Code2, title: "Build something", description: "From a what-if to a working thing", prompt: "Be my coding partner. Ask me what I want to build and help me work through it step by step.", color: "sage" },
  { icon: Sprout, title: "Explore a possibility", description: "Give your next big idea some room", prompt: "Help me brainstorm a new idea. Start by asking what I'm interested in and what I'd like to achieve.", color: "lavender" },
];

export default function ChatWelcome({ onPrompt }: { onPrompt: (text: string) => void }) {
  return (
    <div className="chat-welcome animate-rise" data-testid="kb-empty">
      <div className="idea-orbit" aria-hidden="true">
        <span className="idea-orbit-ring idea-orbit-ring-one" />
        <span className="idea-orbit-ring idea-orbit-ring-two" />
        <span className="idea-orbit-ring idea-orbit-ring-three" />
        <span className="idea-orbit-dot" />
        <FinesseMark className="idea-orbit-spark" />
      </div>
      <p className="welcome-eyebrow">A little curiosity. Endless possibility.</p>
      <h2 className="editorial-heading welcome-title">
        Make space for<br />
        <em>a little finesse.</em>
      </h2>
      <p className="welcome-description">
        A thought, a question, a not-quite-there idea.<br className="hidden sm:block" />
        Bring it here. Let’s see what we can make of it.
      </p>
      <div className="starter-grid" aria-label="Ideas to get started">
        {STARTERS.map(({ icon: Icon, title, description, prompt, color }) => (
          <button key={title} type="button" onClick={() => onPrompt(prompt)} className="starter-card group" data-testid={`starter-${color}`}>
            <span className={`starter-icon starter-icon-${color}`}><Icon className="size-[18px]" aria-hidden /></span>
            <ArrowUpRight className="starter-arrow size-3.5" aria-hidden />
            <span className="starter-title">{title}</span>
            <span className="starter-description">{description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
