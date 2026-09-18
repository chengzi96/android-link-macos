import {AutomationError} from './automation-errors.mjs';

export class RuntimeSpecProvider {
  async getRuntimeSpec() { throw new AutomationError('RUNTIME_SPEC_UNAVAILABLE'); }
}

export class UnavailableRuntimeSpecProvider extends RuntimeSpecProvider {
  async getRuntimeSpec() { throw new AutomationError('RUNTIME_SPEC_UNAVAILABLE', '当前版本尚未配置 RuntimeSpec Provider。'); }
}
