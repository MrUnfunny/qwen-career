import { applyGenericForm } from './browser-form.mjs';

export async function apply(args) {
  return applyGenericForm({ ...args, submitText: /apply|submit/i });
}
