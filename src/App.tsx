import { lazy, Suspense } from 'react';

const Stage = lazy(() => import('./stage/Stage'));
const Controller = lazy(() => import('./controller/Controller'));
const How = lazy(() => import('./how/How'));
// Dev only: `import.meta.env.DEV` is a build-time constant, so production drops this import and its chunk.
const ForeheadPreview = import.meta.env.DEV ? lazy(() => import('./dev/ForeheadPreview')) : null;

/** Three pages, no router needed: `/` Stage, `/j/:code` Controller, `/how` write-up. In dev also `/dev/forehead`. */
export function App() {
  const path = window.location.pathname;
  const join = path.match(/^\/j\/([A-Za-z0-9]+)\/?$/);
  return (
    <Suspense fallback={null}>
      {join ? (
        <Controller code={join[1].toUpperCase()} />
      ) : path.startsWith('/how') ? (
        <How />
      ) : ForeheadPreview && /^\/dev\/forehead\/?$/.test(path) ? (
        <ForeheadPreview />
      ) : (
        <Stage />
      )}
    </Suspense>
  );
}
