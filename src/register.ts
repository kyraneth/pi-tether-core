import { registerApiProvider } from "@earendil-works/pi-ai/compat";
/** Register Pi's legacy API dispatch separately from its provider catalog. */
export function registerApiDispatch(id: string, stream: any): void {
  registerApiProvider({ api: id as any, stream, streamSimple: stream }, id);
}
