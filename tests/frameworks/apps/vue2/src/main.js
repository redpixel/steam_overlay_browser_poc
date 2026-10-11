// Vue 2.7 + Vue Router 3 (full build with template compiler, so no SFC plugin is needed)
import Vue from 'vue';
import VueRouter from 'vue-router';

Vue.use(VueRouter);

function snapshot(route) {
  return { path: route.path, query: Object.assign({}, route.query), hash: route.hash, id: route.params.id || null };
}

const Page = { template: '<pre id="status">{{ JSON.stringify(state) }}</pre>', computed: { state() { return snapshot(this.$route); } } };

const router = new VueRouter({
  mode: window.__ROUTER_MODE__ === 'hash' ? 'hash' : 'history',
  base: '/vue2/',
  routes: [
    { path: '/', component: Page },
    { path: '/event/:id', component: Page },
  ],
});
router.afterEach((to) => { window.__routerState = snapshot(to); });

window.__testNavigate = (p) => router.push(p).catch(() => {});
new Vue({ router, template: '<router-view />' }).$mount('#app');
