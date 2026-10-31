/** Methods only the router may call on a site's objects. */
export const RESERVED_METHOD = /^__celld/;

/** Names inherited from Object.prototype are never site classes or methods: they
 *  resolve through the exports object (`getDurableObjectClass("constructor")` is
 *  the DurableObjectState) or through the facet's prototype. */
export const FORBIDDEN_NAMES = new Set([
	"__proto__",
	"prototype",
	"constructor",
	"toString",
	"valueOf",
	"hasOwnProperty",
	"isPrototypeOf",
	"propertyIsEnumerable",
	"toLocaleString",
	"__defineGetter__",
	"__defineSetter__",
	"__lookupGetter__",
	"__lookupSetter__",
]);
