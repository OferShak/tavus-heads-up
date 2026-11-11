import { lazy, Suspense } from 'react';

const Stage = lazy(() => import('./stage/Stage'));
const Controller = lazy(() => import('./controller/Controller'));
const How = lazy(() => import('./how/How'));

/** Three pages, no router needed: `/` Stage, `/j/:code` Controller, `/how` write-up. */
export function App() {
  const path = window.location.pathname;
  const join = path.match(/^\/j\/([A-Za-z0-9]+)\/?$/);
  return (
    <Suspense fallback={null}>
      {join ? <Controller code={join[1].toUpperCase()} /> : path.startsWith('/how') ? <How /> : <Stage />}
    </Suspense>
  );
}
