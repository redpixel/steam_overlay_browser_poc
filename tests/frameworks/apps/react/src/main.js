// React 19 + React Router 7. createElement instead of JSX so no build plugin is needed.
import { createElement as h, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, createHashRouter, RouterProvider, useLocation, useParams } from 'react-router';

function Page() {
  const location = useLocation();
  const params = useParams();
  const state = {
    path: location.pathname,
    query: Object.fromEntries(new URLSearchParams(location.search)),
    hash: location.hash,
    id: params.id ?? null,
  };
  useEffect(() => { window.__routerState = state; });
  return h('pre', { id: 'status' }, JSON.stringify(state));
}

const routes = [
  { path: '/', element: h(Page) },
  { path: '/event/:id', element: h(Page) },
];
const router = window.__ROUTER_MODE__ === 'hash'
  ? createHashRouter(routes)
  : createBrowserRouter(routes, { basename: '/react' });

window.__testNavigate = (p) => router.navigate(p);
createRoot(document.getElementById('app')).render(h(RouterProvider, { router }));
