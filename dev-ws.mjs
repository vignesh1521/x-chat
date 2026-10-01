// Local only: runs the same WebSocket server next to `next dev`.
import server from "./api/ws.mjs";
server.listen(3001, () => console.log("ws server on ws://localhost:3001"));
