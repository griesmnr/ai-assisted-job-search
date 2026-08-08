import { ping } from "@app/shared";

/**
 * Placeholder root component. Stripped of the Vite demo counter — this is
 * scaffolding, not a feature. Renders `@app/shared`'s ping() to prove the
 * workspace import resolves from the web app too.
 */
function App() {
  return (
    <main>
      <h1>Job Search App</h1>
      <p>shared package says: {ping()}</p>
    </main>
  );
}

export default App;
