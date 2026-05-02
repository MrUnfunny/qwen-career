import { applyGenericForm } from './browser-form.mjs';

export async function apply(args) {
  return applyGenericForm({ ...args, submitText: /submit application|apply/i });
}
