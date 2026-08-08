import { createRoot } from "react-dom/client";
import { InventoryConsumer } from "./App";
import "@feedback/react/styles.css";
import "./styles.css";

if (window.location.pathname === "/") {
  window.history.replaceState({}, "", "/sites/east/inventory");
}

createRoot(document.getElementById("root")!).render(<InventoryConsumer />);
