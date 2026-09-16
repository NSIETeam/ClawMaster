/** Exercise the registered production HTTP routes without opening a shared network listener. */
import { mountEnterpriseRoutes } from '../src/enterprise-host.ts';

export async function enterpriseTransport(store) {
  const routes = new Map();
  const dispose = await mountEnterpriseRoutes({ connection: { fetch: { register(route) {
    routes.set(route.path, route);
    return async () => { routes.delete(route.path); };
  } } } }, store);
  return { dispose, fetch: async (path, init) => {
    const url = new URL(path, 'http://localhost');
    const route = routes.get(url.pathname);
    if (!route || !route.methods.includes(init.method)) throw new Error(`Unregistered enterprise route: ${path}`);
    return route.fetch(new Request(url, init));
  } };
}

export function overviewOf(snapshot, pageRows = 50) {
  return { generation: snapshot.generation ?? 0, revision: snapshot.revision,
    counts: { contacts: snapshot.contacts.length, inventory: snapshot.inventory.length, orders: snapshot.orders.length,
      audit: snapshot.audit.length, followups: 0, lowStock: snapshot.inventory.filter(item => item.stock <= item.reorderAt).length },
    limits: { pageRows, pageBytes: 262144 } };
}
