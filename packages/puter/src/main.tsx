import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/inter";
import "@fontsource-variable/inter-tight";
import { App } from "./App";
import { NotificationApp } from "./notification";
import "./styles.css";

const params = new URLSearchParams(window.location.search);
const Root = params.get("window") === "activity" ? NotificationApp : App;

createRoot(document.getElementById("root")!).render(<Root />);
