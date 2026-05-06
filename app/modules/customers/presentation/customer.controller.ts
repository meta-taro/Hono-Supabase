import type { Customer } from '../domain/customer';
import type { ListCustomersUseCase } from '../application/list-customers.usecase';
import type {
  CreateCustomerUseCase,
  CreateCustomerInput,
} from '../application/create-customer.usecase';
import type { CustomerResponse } from './customer.dto';

// Controller の責務:
//   - UseCase を呼び出す（業務手順は知らない）
//   - domain Entity を Response DTO に変換する（VO の中身を外向きの形にほぐす）
//   - HTTP / Hono 固有の API には触れない（routes 層の仕事）

// 内部関数: domain Customer → Response DTO（VO の値を取り出すだけ）
const toCustomerResponse = (customer: Customer): CustomerResponse => ({
  id: customer.id.value,
  name: customer.name,
  email: customer.email.value,
});

export interface CustomerControllerDeps {
  listCustomers: ListCustomersUseCase;
  createCustomer: CreateCustomerUseCase;
}

export const createCustomerController = (deps: CustomerControllerDeps) => ({
  // GET /v1/customers
  list: async (): Promise<{ customers: CustomerResponse[] }> => {
    const customers = await deps.listCustomers();
    return { customers: customers.map(toCustomerResponse) };
  },

  // POST /v1/customers
  // 入力は routes 側で Zod により検証済み。ここでは UseCase に流すだけ。
  create: async (input: CreateCustomerInput): Promise<CustomerResponse> => {
    const customer = await deps.createCustomer(input);
    return toCustomerResponse(customer);
  },
});

export type CustomerController = ReturnType<typeof createCustomerController>;
