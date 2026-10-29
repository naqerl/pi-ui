import { ActivityView } from "./ActivityView";
import { ChatView } from "./ChatView";
import { EventsView } from "./EventsView";
import { ShaderBackground } from "./ShaderBackground";
import { useChat } from "./use-chat";

export function App() {
  const chat = useChat();
  const path = window.location.pathname;

  let view = (
    <ChatView
      timeline={chat.timeline}
      running={chat.running}
      interrupted={chat.interrupted}
      runStartedAt={chat.runStartedAt}
      mcpEvents={chat.mcpEvents}
      unavailableServers={chat.mcp.unavailable}
      ready={chat.ready}
      send={chat.send}
      stop={chat.stop}
    />
  );

  if (path === "/activity" || path === "/activity/") {
    view = <ActivityView timeline={chat.timeline} ready={chat.ready} />;
  } else if (path === "/events" || path === "/events/") {
    view = <EventsView events={chat.mcpEvents} ready={chat.ready} />;
  }

  return (
    <>
      <ShaderBackground />
      <div className="relative z-10 h-full">{view}</div>
    </>
  );
}
