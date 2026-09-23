import { valueMap } from '@deepseek-ai/cosmokit'

/** Evaluate a JavaScript expression against a loader context scope. */
export function evaluate(ctx: object, expr: string): any {
  // Compile only when a config actually contains `!!js`; constructing this at
  // module load time prevents browser clients from starting under strict CSP.
  // eslint-disable-next-line no-new-func
  const run = new Function('ctx', 'expr', `
    with (ctx) {
      return eval(expr)
    }
  `) as (ctx: object, expr: string) => any
  return run(ctx, expr)
}

/** Recursively replace YAML `!js` expression nodes with evaluated values. */
export function interpolate(ctx: object, value: any) {
  if (isJsExpr(value)) {
    return evaluate(ctx, value.__jsExpr)
  } else if (!value || typeof value !== 'object') {
    return value
  } else if (Array.isArray(value)) {
    return value.map(item => interpolate(ctx, item))
  } else {
    return valueMap(value, item => interpolate(ctx, item))
  }
}

/** Return true when a value is a serialized loader JavaScript expression. */
export function isJsExpr(value: any): value is JsExpr {
  return value instanceof Object && '__jsExpr' in value
}

/** Serialized JavaScript expression produced by the include YAML tag. */
export interface JsExpr {
  __jsExpr: string
}
