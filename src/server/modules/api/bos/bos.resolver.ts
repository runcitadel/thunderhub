import fs from 'fs';
import { rebalance } from 'balanceofsatoshis/swaps';
import { getAccountingReport } from 'balanceofsatoshis/balances';
import { simpleRequest } from 'balanceofsatoshis/commands';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AccountsService } from '../../accounts/accounts.service';
import { CurrentUser } from '../../security/security.decorators';
import { UserId } from '../../security/security.types';
import { Logger } from 'winston';
import { Inject } from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { to } from 'src/server/utils/async';
import { BosRebalanceResult, RebalanceResponseType } from './bos.types';
import { WsService } from '../../ws/ws.service';
import { stripAnsi } from 'src/server/utils/string';

@Resolver()
export class BosResolver {
  constructor(
    private wsService: WsService,
    private accountsService: AccountsService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger
  ) {}

  @Query(() => String)
  async getAccountingReport(
    @CurrentUser() user: UserId,
    @Args('category', { nullable: true }) category?: string,
    @Args('currency', { nullable: true }) currency?: string,
    @Args('fiat', { nullable: true }) fiat?: string,
    @Args('month', { nullable: true }) month?: string,
    @Args('year', { nullable: true }) year?: string
  ) {
    const account = this.accountsService.getAccount(user.id);
    if (!account) throw new Error('Node account not found');

    this.logger.info('Generating accounting report', {
      category,
      currency,
      fiat,
      month,
      year,
    });

    const response = await to(
      getAccountingReport({
        lnd: account.lnd,
        logger: this.logger,
        request: simpleRequest,
        is_csv: true,
        category,
        currency,
        fiat,
        month,
        year,
        rate_provider: 'coingecko',
      })
    );

    return response;
  }

  @Mutation(() => BosRebalanceResult)
  async bosRebalance(
    @CurrentUser() user: UserId,
    @Args('avoid', { nullable: true, type: () => [String] }) avoid?: string[],
    @Args('in_through', { nullable: true }) in_through?: string,
    @Args('max_fee', { nullable: true }) max_fee?: number,
    @Args('max_fee_rate', { nullable: true }) max_fee_rate?: number,
    @Args('max_rebalance', { nullable: true }) max_rebalance?: number,
    @Args('timeout_minutes', { nullable: true }) timeout_minutes?: number,
    @Args('node', { nullable: true }) node?: string,
    @Args('out_through', { nullable: true }) out_through?: string,
    @Args('out_inbound', { nullable: true }) out_inbound?: number
  ) {
    const account = this.accountsService.getAccount(user.id);
    if (!account) throw new Error('Node account not found');

    const filteredParams = {
      out_channels: [],
      avoid,
      ...(in_through && { in_through }),
      ...(max_fee && max_fee > 0 && { max_fee }),
      ...(max_fee_rate && max_fee_rate > 0 && { max_fee_rate }),
      ...(timeout_minutes ? { timeout_minutes } : { timeout_minutes: 5 }),
      ...(max_rebalance && max_rebalance > 0
        ? { max_rebalance: `${max_rebalance}` }
        : {}),
      ...(node && { node }),
      ...(out_through && { out_through }),
      ...(out_inbound && out_inbound > 0
        ? { out_inbound: `${out_inbound}` }
        : {}),
    };

    this.logger.info('Rebalance Params', { filteredParams });

    const logger = {
      info: (message, ...args) => {
        let payload = message;

        if (payload?.evaluating?.length) {
          payload = {
            evaluating: payload.evaluating.map((m: string) => stripAnsi(m)),
          };
        }

        this.wsService.emit(user.id, 'rebalance', payload);
        this.logger.info(message, args);
      },
      warn: (message, ...args) => {
        this.wsService.emit(user.id, 'rebalance', message);
        this.logger.warn(message, args);
      },
      error: (message, ...args) => {
        this.wsService.emit(user.id, 'rebalance', message);
        this.logger.error(message, args);
      },
    };

    const response = await to<RebalanceResponseType>(
      rebalance({
        lnd: account.lnd,
        logger,
        fs: { getFile: fs.readFile },
        ...filteredParams,
      })
    );

    const result = {
      increase: response.rebalance[0],
      decrease: response.rebalance[1],
      result: response.rebalance[2],
    };

    return result;
  }
}