import { ActivityView } from "./ActivityView";
import { ChatView } from "./ChatView";
import { useChat } from "./use-chat";

export function App() {
  const chat = useChat();
  const path = window.location.pathname;
  const isActivity = path === "/activity" || path === "/activity/";

  if (isActivity) {
    return <ActivityView timeline={chat.timeline} ready={chat.ready} />;
  }

  return (
    <ChatView
      timeline={chat.timeline}
      running={chat.running}
      ready={chat.ready}
      send={chat.send}
      stop={chat.stop}
    />
  );
}
