import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // Vite's dev server binds to `localhost` only by default -- inside a
    // container, that's the CONTAINER's own loopback, not reachable via
    // Docker's port publishing (which connects to the container's network
    // interface, not its loopback). `host: true` binds 0.0.0.0 so
    // docker-compose.yml's `127.0.0.1:5173:5173` mapping actually has
    // something to forward to. Harmless outside a container too -- it just
    // means "also accept non-localhost connections," which nothing takes
    // advantage of on a bare host.
    host: true,
  },
});
