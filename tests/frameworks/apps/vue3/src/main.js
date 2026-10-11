// Vue 3 + Vue Router 4 (runtime template compiler build, so no SFC plugin is needed)
import { createApp } from 'vue';
import { createRouter, createWebHistory, createWebHashHistory } from 'vue-router';

const Page = { template: '<pre id="status">{{ JSON.stringify(state) }}</pre>', computed: { state() { return snapshot(this.$route); } } };

function snapshot(route) {
  return { path: route.path, query: { ...route.query }, hash: route.hash, id: route.params.id ?? null };
}

const router = createRouter({
  history: window.__ROUTER_MODE__ === 'hash' ? createWebHashHistory() : createWebHistory('/vue3/'),
  routes: [
    { path: '/', component: Page },
    { path: '/event/:id', component: Page },
  ],
});
router.afterEach((to) => { window.__routerState = snapshot(to); });

window.__testNavigate = (p) => router.push(p);
createApp({ template: '<router-view />' }).use(router).mount('#app');
