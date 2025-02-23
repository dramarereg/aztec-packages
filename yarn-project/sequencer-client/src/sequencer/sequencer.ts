import {
  type EpochProofQuote,
  type L1RollupConstants,
  type L1ToL2MessageSource,
  type L2Block,
  type L2BlockSource,
  SequencerConfigSchema,
  Tx,
  type TxHash,
  type WorldStateSynchronizer,
} from '@aztec/circuit-types';
import type { AllowedElement, Signature, WorldStateSynchronizerStatus } from '@aztec/circuit-types/interfaces';
import { type L2BlockBuiltStats } from '@aztec/circuit-types/stats';
import {
  AppendOnlyTreeSnapshot,
  BlockHeader,
  ContentCommitment,
  type ContractDataSource,
  GENESIS_ARCHIVE_ROOT,
  Gas,
  type GlobalVariables,
  StateReference,
} from '@aztec/circuits.js';
import { AztecAddress } from '@aztec/foundation/aztec-address';
import { omit } from '@aztec/foundation/collection';
import { EthAddress } from '@aztec/foundation/eth-address';
import { Fr } from '@aztec/foundation/fields';
import { createLogger } from '@aztec/foundation/log';
import { RunningPromise } from '@aztec/foundation/running-promise';
import { pickFromSchema } from '@aztec/foundation/schemas';
import { type DateProvider, Timer, elapsed } from '@aztec/foundation/timer';
import { type P2P } from '@aztec/p2p';
import { type BlockBuilderFactory } from '@aztec/prover-client/block-builder';
import { type PublicProcessorFactory } from '@aztec/simulator';
import { Attributes, type TelemetryClient, type Tracer, trackSpan } from '@aztec/telemetry-client';
import { type ValidatorClient } from '@aztec/validator-client';

import { type GlobalVariableBuilder } from '../global_variable_builder/global_builder.js';
import { type L1Publisher, VoteType } from '../publisher/l1-publisher.js';
import { prettyLogViemErrorMsg } from '../publisher/utils.js';
import { type SlasherClient } from '../slasher/slasher_client.js';
import { createValidatorsForBlockBuilding } from '../tx_validator/tx_validator_factory.js';
import { getDefaultAllowedSetupFunctions } from './allowed.js';
import { type SequencerConfig } from './config.js';
import { SequencerMetrics } from './metrics.js';
import { SequencerState, orderAttestations } from './utils.js';

export { SequencerState };

export class SequencerTooSlowError extends Error {
  constructor(
    public readonly currentState: SequencerState,
    public readonly proposedState: SequencerState,
    public readonly maxAllowedTime: number,
    public readonly currentTime: number,
  ) {
    super(
      `Too far into slot to transition to ${proposedState} (max allowed: ${maxAllowedTime}s, time into slot: ${currentTime}s)`,
    );
    this.name = 'SequencerTooSlowError';
  }
}

type SequencerRollupConstants = Pick<L1RollupConstants, 'ethereumSlotDuration' | 'l1GenesisTime' | 'slotDuration'>;

/**
 * Sequencer client
 * - Wins a period of time to become the sequencer (depending on finalized protocol).
 * - Chooses a set of txs from the tx pool to be in the rollup.
 * - Simulate the rollup of txs.
 * - Adds proof requests to the request pool (not for this milestone).
 * - Receives results to those proofs from the network (repeats as necessary) (not for this milestone).
 * - Publishes L1 tx(s) to the rollup contract via RollupPublisher.
 */
export class Sequencer {
  private runningPromise?: RunningPromise;
  private pollingIntervalMs: number = 1000;
  private maxTxsPerBlock = 32;
  private minTxsPerBLock = 1;
  private maxL1TxInclusionTimeIntoSlot = 0;
  // TODO: zero values should not be allowed for the following 2 values in PROD
  private _coinbase = EthAddress.ZERO;
  private _feeRecipient = AztecAddress.ZERO;
  private state = SequencerState.STOPPED;
  private allowedInSetup: AllowedElement[] = getDefaultAllowedSetupFunctions();
  private maxBlockSizeInBytes: number = 1024 * 1024;
  private maxBlockGas: Gas = new Gas(10e9, 10e9);
  private processTxTime: number = 12;
  private metrics: SequencerMetrics;
  private isFlushing: boolean = false;

  /**
   * The maximum number of seconds that the sequencer can be into a slot to transition to a particular state.
   * For example, in order to transition into WAITING_FOR_ATTESTATIONS, the sequencer can be at most 3 seconds into the slot.
   */
  protected timeTable!: Record<SequencerState, number>;
  protected enforceTimeTable: boolean = false;

  constructor(
    private publisher: L1Publisher,
    private validatorClient: ValidatorClient | undefined, // During migration the validator client can be inactive
    private globalsBuilder: GlobalVariableBuilder,
    private p2pClient: P2P,
    private worldState: WorldStateSynchronizer,
    private slasherClient: SlasherClient,
    private blockBuilderFactory: BlockBuilderFactory,
    private l2BlockSource: L2BlockSource,
    private l1ToL2MessageSource: L1ToL2MessageSource,
    private publicProcessorFactory: PublicProcessorFactory,
    private contractDataSource: ContractDataSource,
    protected l1Constants: SequencerRollupConstants,
    private dateProvider: DateProvider,
    telemetry: TelemetryClient,
    private config: SequencerConfig = {},
    private log = createLogger('sequencer'),
  ) {
    this.updateConfig(config);
    this.metrics = new SequencerMetrics(telemetry, () => this.state, 'Sequencer');

    // Register the block builder with the validator client for re-execution
    this.validatorClient?.registerBlockBuilder(this.buildBlock.bind(this));

    // Register the slasher on the publisher to fetch slashing payloads
    this.publisher.registerSlashPayloadGetter(this.slasherClient.getSlashPayload.bind(this.slasherClient));
  }

  get tracer(): Tracer {
    return this.metrics.tracer;
  }

  /**
   * Updates sequencer config.
   * @param config - New parameters.
   */
  public updateConfig(config: SequencerConfig) {
    this.log.info(`Sequencer config set`, omit(pickFromSchema(config, SequencerConfigSchema), 'allowedInSetup'));

    if (config.transactionPollingIntervalMS !== undefined) {
      this.pollingIntervalMs = config.transactionPollingIntervalMS;
    }
    if (config.maxTxsPerBlock !== undefined) {
      this.maxTxsPerBlock = config.maxTxsPerBlock;
    }
    if (config.minTxsPerBlock !== undefined) {
      this.minTxsPerBLock = config.minTxsPerBlock;
    }
    if (config.maxDABlockGas !== undefined) {
      this.maxBlockGas = new Gas(config.maxDABlockGas, this.maxBlockGas.l2Gas);
    }
    if (config.maxL2BlockGas !== undefined) {
      this.maxBlockGas = new Gas(this.maxBlockGas.daGas, config.maxL2BlockGas);
    }
    if (config.coinbase) {
      this._coinbase = config.coinbase;
    }
    if (config.feeRecipient) {
      this._feeRecipient = config.feeRecipient;
    }
    if (config.allowedInSetup) {
      this.allowedInSetup = config.allowedInSetup;
    }
    if (config.maxBlockSizeInBytes !== undefined) {
      this.maxBlockSizeInBytes = config.maxBlockSizeInBytes;
    }
    if (config.governanceProposerPayload) {
      this.publisher.setGovernancePayload(config.governanceProposerPayload);
    }
    if (config.maxL1TxInclusionTimeIntoSlot !== undefined) {
      this.maxL1TxInclusionTimeIntoSlot = config.maxL1TxInclusionTimeIntoSlot;
    }
    this.enforceTimeTable = config.enforceTimeTable === true;

    this.setTimeTable();

    // TODO: Just read everything from the config object as needed instead of copying everything into local vars.
    this.config = config;
  }

  private setTimeTable() {
    // How late into the slot can we be to start working
    const initialTime = 2;

    // How long it takes to get ready to start building
    const blockPrepareTime = 1;

    // How long it takes to for attestations to travel across the p2p layer.
    const attestationPropagationTime = 2;

    // How long it takes to get a published block into L1. L1 builders typically accept txs up to 4 seconds into their slot,
    // but we'll timeout sooner to give it more time to propagate (remember we also have blobs!). Still, when working in anvil,
    // we can just post in the very last second of the L1 slot.
    const l1PublishingTime = this.l1Constants.ethereumSlotDuration - this.maxL1TxInclusionTimeIntoSlot;

    // How much time we spend validating and processing a block after building it
    const blockValidationTime = 1;

    // How much time we have left in the slot for actually processing txs and building the block.
    const remainingTimeInSlot =
      this.aztecSlotDuration -
      initialTime -
      blockPrepareTime -
      l1PublishingTime -
      2 * attestationPropagationTime -
      blockValidationTime;

    // Check that numbers make sense
    if (this.enforceTimeTable && remainingTimeInSlot < 0) {
      throw new Error(`Not enough time for block building in ${this.aztecSlotDuration}s slot`);
    }

    // How much time we have for actually processing txs. Note that we need both the sequencer and the validators to execute txs.
    const processTxsTime = remainingTimeInSlot / 2;
    this.processTxTime = processTxsTime;

    const newTimeTable: Record<SequencerState, number> = {
      // No checks needed for any of these transitions
      [SequencerState.STOPPED]: this.aztecSlotDuration,
      [SequencerState.IDLE]: this.aztecSlotDuration,
      [SequencerState.SYNCHRONIZING]: this.aztecSlotDuration,
      // We always want to allow the full slot to check if we are the proposer
      [SequencerState.PROPOSER_CHECK]: this.aztecSlotDuration,
      // How late we can start initializing a new block proposal
      [SequencerState.INITIALIZING_PROPOSAL]: initialTime,
      // When we start building a block
      [SequencerState.CREATING_BLOCK]: initialTime + blockPrepareTime,
      // We start collecting attestations after building the block
      [SequencerState.COLLECTING_ATTESTATIONS]: initialTime + blockPrepareTime + processTxsTime + blockValidationTime,
      // We publish the block after collecting attestations
      [SequencerState.PUBLISHING_BLOCK]: this.aztecSlotDuration - l1PublishingTime,
    };

    this.log.verbose(`Sequencer time table updated with ${processTxsTime}s for processing txs`, newTimeTable);
    this.timeTable = newTimeTable;
  }

  /**
   * Starts the sequencer and moves to IDLE state.
   */
  public start() {
    this.runningPromise = new RunningPromise(this.work.bind(this), this.log, this.pollingIntervalMs);
    this.setState(SequencerState.IDLE, 0n, true /** force */);
    this.runningPromise.start();
    this.log.info(`Sequencer started with address ${this.publisher.getSenderAddress().toString()}`);
    return Promise.resolve();
  }

  /**
   * Stops the sequencer from processing txs and moves to STOPPED state.
   */
  public async stop(): Promise<void> {
    this.log.debug(`Stopping sequencer`);
    await this.validatorClient?.stop();
    await this.runningPromise?.stop();
    await this.slasherClient?.stop();
    this.publisher.interrupt();
    this.setState(SequencerState.STOPPED, 0n, true /** force */);
    this.log.info('Stopped sequencer');
  }

  /**
   * Starts a previously stopped sequencer.
   */
  public restart() {
    this.log.info('Restarting sequencer');
    this.publisher.restart();
    this.runningPromise!.start();
    this.setState(SequencerState.IDLE, 0n, true /** force */);
  }

  /**
   * Returns the current state of the sequencer.
   * @returns An object with a state entry with one of SequencerState.
   */
  public status() {
    return { state: this.state };
  }

  /**
   * @notice  Performs most of the sequencer duties:
   *          - Checks if we are up to date
   *          - If we are and we are the sequencer, collect txs and build a block
   *          - Collect attestations for the block
   *          - Submit block
   *          - If our block for some reason is not included, revert the state
   */
  protected async doRealWork() {
    this.setState(SequencerState.SYNCHRONIZING, 0n);
    // Update state when the previous block has been synced
    const prevBlockSynced = await this.isBlockSynced();
    // Do not go forward with new block if the previous one has not been mined and processed
    if (!prevBlockSynced) {
      return;
    }

    this.setState(SequencerState.PROPOSER_CHECK, 0n);

    const chainTip = await this.l2BlockSource.getBlock(-1);
    const historicalHeader = chainTip?.header;

    const newBlockNumber =
      (historicalHeader === undefined
        ? await this.l2BlockSource.getBlockNumber()
        : Number(historicalHeader.globalVariables.blockNumber.toBigInt())) + 1;

    // If we cannot find a tip archive, assume genesis.
    const chainTipArchive =
      chainTip == undefined ? new Fr(GENESIS_ARCHIVE_ROOT).toBuffer() : chainTip?.archive.root.toBuffer();

    let slot: bigint;
    try {
      slot = await this.mayProposeBlock(chainTipArchive, BigInt(newBlockNumber));
    } catch (err) {
      this.log.debug(`Cannot propose for block ${newBlockNumber}`);
      return;
    }

    const newGlobalVariables = await this.globalsBuilder.buildGlobalVariables(
      new Fr(newBlockNumber),
      this._coinbase,
      this._feeRecipient,
      slot,
    );

    void this.publisher.castVote(slot, newGlobalVariables.timestamp.toBigInt(), VoteType.GOVERNANCE);
    void this.publisher.castVote(slot, newGlobalVariables.timestamp.toBigInt(), VoteType.SLASHING);

    // Check the pool has enough txs to build a block
    const pendingTxCount = this.p2pClient.getPendingTxCount();
    if (pendingTxCount < this.minTxsPerBLock && !this.isFlushing) {
      this.log.verbose(`Not enough txs to propose block. Got ${pendingTxCount} min ${this.minTxsPerBLock}.`, {
        slot,
        blockNumber: newBlockNumber,
      });
      await this.claimEpochProofRightIfAvailable(slot);
      return;
    }

    this.setState(SequencerState.INITIALIZING_PROPOSAL, slot);
    this.log.verbose(`Preparing proposal for block ${newBlockNumber} at slot ${slot}`, {
      chainTipArchive: new Fr(chainTipArchive),
      blockNumber: newBlockNumber,
      slot,
    });

    // We don't fetch exactly maxTxsPerBlock txs here because we may not need all of them if we hit a limit before,
    // and also we may need to fetch more if we don't have enough valid txs.
    const pendingTxs = this.p2pClient.iteratePendingTxs();

    // If I created a "partial" header here that should make our job much easier.
    const proposalHeader = new BlockHeader(
      new AppendOnlyTreeSnapshot(Fr.fromBuffer(chainTipArchive), 1),
      ContentCommitment.empty(),
      StateReference.empty(),
      newGlobalVariables,
      Fr.ZERO,
      Fr.ZERO,
    );

    try {
      // TODO(palla/txs) Is the note below still valid? We don't seem to be doing any rollback in there.
      // @note  It is very important that the following function will FAIL and not just return early
      //        if it have made any state changes. If not, we won't rollback the state, and you will
      //        be in for a world of pain.
      await this.buildBlockAndAttemptToPublish(pendingTxs, proposalHeader, historicalHeader);
    } catch (err) {
      this.log.error(`Error assembling block`, err, { blockNumber: newBlockNumber, slot });
    }
    this.setState(SequencerState.IDLE, 0n);
  }

  @trackSpan('Sequencer.work')
  protected async work() {
    try {
      await this.doRealWork();
    } catch (err) {
      if (err instanceof SequencerTooSlowError) {
        this.log.warn(err.message);
      } else {
        // Re-throw other errors
        throw err;
      }
    } finally {
      this.setState(SequencerState.IDLE, 0n);
    }
  }

  async mayProposeBlock(tipArchive: Buffer, proposalBlockNumber: bigint): Promise<bigint> {
    // This checks that we can propose, and gives us the slot that we are to propose for
    try {
      const [slot, blockNumber] = await this.publisher.canProposeAtNextEthBlock(tipArchive);

      if (proposalBlockNumber !== blockNumber) {
        const msg = `Sequencer block number mismatch. Expected ${proposalBlockNumber} but got ${blockNumber}.`;
        this.log.warn(msg);
        throw new Error(msg);
      }
      return slot;
    } catch (err) {
      const msg = prettyLogViemErrorMsg(err);
      this.log.debug(
        `Rejected from being able to propose at next block with ${tipArchive.toString('hex')}: ${msg ? `${msg}` : ''}`,
      );
      throw err;
    }
  }

  doIHaveEnoughTimeLeft(proposedState: SequencerState, secondsIntoSlot: number): boolean {
    if (!this.enforceTimeTable) {
      return true;
    }

    const maxAllowedTime = this.timeTable[proposedState];
    if (maxAllowedTime === this.aztecSlotDuration) {
      return true;
    }

    const bufferSeconds = maxAllowedTime - secondsIntoSlot;

    if (bufferSeconds < 0) {
      this.log.debug(`Too far into slot to transition to ${proposedState}`, { maxAllowedTime, secondsIntoSlot });
      return false;
    }

    this.metrics.recordStateTransitionBufferMs(Math.floor(bufferSeconds * 1000), proposedState);

    this.log.trace(`Enough time to transition to ${proposedState}`, { maxAllowedTime, secondsIntoSlot });
    return true;
  }

  /**
   * Sets the sequencer state and checks if we have enough time left in the slot to transition to the new state.
   * @param proposedState - The new state to transition to.
   * @param currentSlotNumber - The current slot number.
   * @param force - Whether to force the transition even if the sequencer is stopped.
   *
   * @dev If the `currentSlotNumber` doesn't matter (e.g. transitioning to IDLE), pass in `0n`;
   * it is only used to check if we have enough time left in the slot to transition to the new state.
   */
  setState(proposedState: SequencerState, currentSlotNumber: bigint, force: boolean = false) {
    if (this.state === SequencerState.STOPPED && force !== true) {
      this.log.warn(`Cannot set sequencer from ${this.state} to ${proposedState} as it is stopped.`);
      return;
    }
    const secondsIntoSlot = this.getSecondsIntoSlot(currentSlotNumber);
    if (!this.doIHaveEnoughTimeLeft(proposedState, secondsIntoSlot)) {
      throw new SequencerTooSlowError(this.state, proposedState, this.timeTable[proposedState], secondsIntoSlot);
    }
    this.log.debug(`Transitioning from ${this.state} to ${proposedState}`);
    this.state = proposedState;
  }

  /**
   * Build a block
   *
   * Shared between the sequencer and the validator for re-execution
   *
   * @param pendingTxs - The pending transactions to construct the block from
   * @param newGlobalVariables - The global variables for the new block
   * @param historicalHeader - The historical header of the parent
   * @param opts - Whether to just validate the block as a validator, as opposed to building it as a proposal
   */
  private async buildBlock(
    pendingTxs: Iterable<Tx>,
    newGlobalVariables: GlobalVariables,
    historicalHeader?: BlockHeader,
    opts: { validateOnly?: boolean } = {},
  ) {
    const blockNumber = newGlobalVariables.blockNumber.toBigInt();
    const slot = newGlobalVariables.slotNumber.toBigInt();

    this.log.debug(`Requesting L1 to L2 messages from contract for block ${blockNumber}`);
    const l1ToL2Messages = await this.l1ToL2MessageSource.getL1ToL2Messages(blockNumber);
    const msgCount = l1ToL2Messages.length;

    this.log.verbose(`Building block ${blockNumber} for slot ${slot}`, { slot, blockNumber, msgCount });

    // Sync to the previous block at least
    await this.worldState.syncImmediate(newGlobalVariables.blockNumber.toNumber() - 1);
    this.log.debug(`Synced to previous block ${newGlobalVariables.blockNumber.toNumber() - 1}`);

    // NB: separating the dbs because both should update the state
    const publicProcessorFork = await this.worldState.fork();
    const orchestratorFork = await this.worldState.fork();

    try {
      const processor = this.publicProcessorFactory.create(
        publicProcessorFork,
        historicalHeader,
        newGlobalVariables,
        true,
      );
      const blockBuildingTimer = new Timer();
      const blockBuilder = this.blockBuilderFactory.create(orchestratorFork);
      await blockBuilder.startNewBlock(newGlobalVariables, l1ToL2Messages);

      // We set the deadline for tx processing to the start of the CREATING_BLOCK phase, plus the expected time for tx processing.
      // Deadline is only set if enforceTimeTable is enabled.
      const processingEndTimeWithinSlot = this.timeTable[SequencerState.CREATING_BLOCK] + this.processTxTime;
      const deadline = this.enforceTimeTable
        ? new Date((this.getSlotStartTimestamp(slot) + processingEndTimeWithinSlot) * 1000)
        : undefined;
      this.log.verbose(`Processing pending txs`, {
        slot,
        slotStart: new Date(this.getSlotStartTimestamp(slot) * 1000),
        now: new Date(this.dateProvider.now()),
        deadline,
      });

      const validators = createValidatorsForBlockBuilding(
        publicProcessorFork,
        this.contractDataSource,
        newGlobalVariables,
        !!this.config.enforceFees,
        this.allowedInSetup,
      );

      // REFACTOR: Public processor should just handle processing, one tx at a time. It should be responsibility
      // of the sequencer to update world state and iterate over txs. We should refactor this along with unifying the
      // publicProcessorFork and orchestratorFork, to avoid doing tree insertions twice when building the block.
      const limits = { deadline, maxTransactions: this.maxTxsPerBlock, maxBlockSize: this.maxBlockSizeInBytes };
      const [publicProcessorDuration, [processedTxs, failedTxs]] = await elapsed(() =>
        processor.process(pendingTxs, limits, validators),
      );

      if (failedTxs.length > 0) {
        const failedTxData = failedTxs.map(fail => fail.tx);
        this.log.verbose(`Dropping failed txs ${Tx.getHashes(failedTxData).join(', ')}`);
        await this.p2pClient.deleteTxs(Tx.getHashes(failedTxData));
      }

      if (
        !opts.validateOnly && // We check for minTxCount only if we are proposing a block, not if we are validating it
        !this.isFlushing && // And we skip the check when flushing, since we want all pending txs to go out, no matter if too few
        this.minTxsPerBLock !== undefined &&
        processedTxs.length < this.minTxsPerBLock
      ) {
        this.log.warn(
          `Block ${blockNumber} has too few txs to be proposed (got ${processedTxs.length} but required ${this.minTxsPerBLock})`,
          { slot, blockNumber, processedTxCount: processedTxs.length },
        );
        throw new Error(`Block has too few successful txs to be proposed`);
      }

      const start = process.hrtime.bigint();
      await blockBuilder.addTxs(processedTxs);
      const end = process.hrtime.bigint();
      const duration = Number(end - start) / 1_000;
      this.metrics.recordBlockBuilderTreeInsertions(duration);

      // All real transactions have been added, set the block as full and pad if needed
      const block = await blockBuilder.setBlockCompleted();

      return {
        block,
        publicProcessorDuration,
        numMsgs: l1ToL2Messages.length,
        numTxs: processedTxs.length,
        blockBuildingTimer,
      };
    } finally {
      // We create a fresh processor each time to reset any cached state (eg storage writes)
      // We wait a bit to close the forks since the processor may still be working on a dangling tx
      // which was interrupted due to the processingDeadline being hit.
      setTimeout(async () => {
        try {
          await publicProcessorFork.close();
          await orchestratorFork.close();
        } catch (err) {
          this.log.error(`Error closing forks`, err);
        }
      }, 5000);
    }
  }

  /**
   * @notice  Build and propose a block to the chain
   *
   * @dev     MUST throw instead of exiting early to ensure that world-state
   *          is being rolled back if the block is dropped.
   *
   * @param pendingTxs - Iterable of pending transactions to construct the block from
   * @param proposalHeader - The partial header constructed for the proposal
   * @param historicalHeader - The historical header of the parent
   */
  @trackSpan('Sequencer.buildBlockAndAttemptToPublish', (_validTxs, proposalHeader, _historicalHeader) => ({
    [Attributes.BLOCK_NUMBER]: proposalHeader.globalVariables.blockNumber.toNumber(),
  }))
  private async buildBlockAndAttemptToPublish(
    pendingTxs: Iterable<Tx>,
    proposalHeader: BlockHeader,
    historicalHeader: BlockHeader | undefined,
  ): Promise<void> {
    await this.publisher.validateBlockForSubmission(proposalHeader);

    const newGlobalVariables = proposalHeader.globalVariables;
    const blockNumber = newGlobalVariables.blockNumber.toNumber();
    const slot = newGlobalVariables.slotNumber.toBigInt();

    // this.metrics.recordNewBlock(blockNumber, validTxs.length);
    const workTimer = new Timer();
    this.setState(SequencerState.CREATING_BLOCK, slot);

    // Start collecting proof quotes for the previous epoch if needed in the background
    const proofQuotePromise = this.createProofClaimForPreviousEpoch(slot);

    try {
      const buildBlockRes = await this.buildBlock(pendingTxs, newGlobalVariables, historicalHeader);
      const { block, publicProcessorDuration, numTxs, numMsgs, blockBuildingTimer } = buildBlockRes;

      // TODO(@PhilWindle) We should probably periodically check for things like another
      // block being published before ours instead of just waiting on our block
      await this.publisher.validateBlockForSubmission(block.header);

      const workDuration = workTimer.ms();
      const blockStats: L2BlockBuiltStats = {
        eventName: 'l2-block-built',
        creator: this.publisher.getSenderAddress().toString(),
        duration: workDuration,
        publicProcessDuration: publicProcessorDuration,
        rollupCircuitsDuration: blockBuildingTimer.ms(),
        ...block.getStats(),
      };

      const blockHash = block.hash();
      const txHashes = block.body.txEffects.map(tx => tx.txHash);
      this.log.info(`Built block ${block.number} for slot ${slot} with ${numTxs} txs`, {
        blockHash,
        globalVariables: block.header.globalVariables.toInspect(),
        txHashes,
        ...blockStats,
      });

      if (this.isFlushing) {
        this.log.verbose(`Sequencer flushing completed`);
      }

      this.isFlushing = false;
      this.log.debug('Collecting attestations');
      const stopCollectingAttestationsTimer = this.metrics.startCollectingAttestationsTimer();
      const attestations = await this.collectAttestations(block, txHashes);
      if (attestations !== undefined) {
        this.log.verbose(`Collected ${attestations.length} attestations`, { blockHash, blockNumber });
      }
      stopCollectingAttestationsTimer();

      // Get the proof quote for the previous epoch, if any
      const proofQuote = await proofQuotePromise;

      await this.publishL2Block(block, attestations, txHashes, proofQuote);
      this.metrics.recordPublishedBlock(workDuration);
      this.log.info(
        `Published block ${block.number} with ${numTxs} txs and ${numMsgs} messages in ${Math.ceil(workDuration)}ms`,
        {
          blockNumber: block.number,
          blockHash: blockHash,
          slot,
          txCount: txHashes.length,
          msgCount: numMsgs,
          duration: Math.ceil(workDuration),
          submitter: this.publisher.getSenderAddress().toString(),
        },
      );
    } catch (err) {
      this.metrics.recordFailedBlock();
      throw err;
    }
  }

  /** Forces the sequencer to bypass all time and tx count checks for the next block and build anyway. */
  public flush() {
    this.isFlushing = true;
  }

  @trackSpan('Sequencer.collectAttestations', (block, txHashes) => ({
    [Attributes.BLOCK_NUMBER]: block.number,
    [Attributes.BLOCK_ARCHIVE]: block.archive.toString(),
    [Attributes.BLOCK_TXS_COUNT]: txHashes.length,
  }))
  protected async collectAttestations(block: L2Block, txHashes: TxHash[]): Promise<Signature[] | undefined> {
    // TODO(https://github.com/AztecProtocol/aztec-packages/issues/7962): inefficient to have a round trip in here - this should be cached
    const committee = await this.publisher.getCurrentEpochCommittee();

    if (committee.length === 0) {
      this.log.verbose(`Attesting committee is empty`);
      return undefined;
    } else {
      this.log.debug(`Attesting committee length is ${committee.length}`);
    }

    if (!this.validatorClient) {
      const msg = 'Missing validator client: Cannot collect attestations';
      this.log.error(msg);
      throw new Error(msg);
    }

    const numberOfRequiredAttestations = Math.floor((committee.length * 2) / 3) + 1;
    const slotNumber = block.header.globalVariables.slotNumber.toBigInt();
    this.setState(SequencerState.COLLECTING_ATTESTATIONS, slotNumber);

    this.log.debug('Creating block proposal for validators');
    const proposal = await this.validatorClient.createBlockProposal(block.header, block.archive.root, txHashes);
    if (!proposal) {
      this.log.warn(`Failed to create block proposal, skipping collecting attestations`);
      return undefined;
    }

    this.log.debug('Broadcasting block proposal to validators');
    this.validatorClient.broadcastBlockProposal(proposal);

    const attestations = await this.validatorClient.collectAttestations(proposal, numberOfRequiredAttestations);

    // note: the smart contract requires that the signatures are provided in the order of the committee
    return orderAttestations(attestations, committee);
  }

  protected async createProofClaimForPreviousEpoch(slotNumber: bigint): Promise<EpochProofQuote | undefined> {
    try {
      // Find out which epoch we are currently in
      const epochToProve = await this.publisher.getClaimableEpoch();
      if (epochToProve === undefined) {
        this.log.trace(`No epoch to prove at slot ${slotNumber}`);
        return undefined;
      }

      // Get quotes for the epoch to be proven
      this.log.debug(`Collecting proof quotes for epoch ${epochToProve}`);
      const quotes = await this.p2pClient.getEpochProofQuotes(epochToProve);
      this.log.verbose(`Retrieved ${quotes.length} quotes for slot ${slotNumber} epoch ${epochToProve}`, {
        epochToProve,
        slotNumber,
        quotes: quotes.map(q => q.payload),
      });
      // ensure these quotes are still valid for the slot and have the contract validate them
      const validQuotesPromise = Promise.all(
        quotes
          .filter(x => x.payload.validUntilSlot >= slotNumber)
          .filter(x => x.payload.epochToProve === epochToProve)
          .map(x => this.publisher.validateProofQuote(x)),
      );

      const validQuotes = (await validQuotesPromise).filter((q): q is EpochProofQuote => !!q);
      if (!validQuotes.length) {
        this.log.warn(`Failed to find any valid proof quotes`);
        return undefined;
      }
      // pick the quote with the lowest fee
      const sortedQuotes = validQuotes.sort(
        (a: EpochProofQuote, b: EpochProofQuote) => a.payload.basisPointFee - b.payload.basisPointFee,
      );
      const quote = sortedQuotes[0];
      this.log.info(`Selected proof quote for proof claim`, { quote: quote.toInspect() });
      return quote;
    } catch (err) {
      this.log.error(`Failed to create proof claim for previous epoch`, err, { slotNumber });
      return undefined;
    }
  }

  /**
   * Publishes the L2Block to the rollup contract.
   * @param block - The L2Block to be published.
   */
  @trackSpan('Sequencer.publishL2Block', block => ({
    [Attributes.BLOCK_NUMBER]: block.number,
  }))
  protected async publishL2Block(
    block: L2Block,
    attestations?: Signature[],
    txHashes?: TxHash[],
    proofQuote?: EpochProofQuote,
  ) {
    // Publishes new block to the network and awaits the tx to be mined
    this.setState(SequencerState.PUBLISHING_BLOCK, block.header.globalVariables.slotNumber.toBigInt());

    const publishedL2Block = await this.publisher.proposeL2Block(block, attestations, txHashes, proofQuote);
    if (!publishedL2Block) {
      throw new Error(`Failed to publish block ${block.number}`);
    }
  }

  @trackSpan(
    'Sequencer.claimEpochProofRightIfAvailable',
    slotNumber => ({ [Attributes.SLOT_NUMBER]: Number(slotNumber) }),
    epoch => ({ [Attributes.EPOCH_NUMBER]: Number(epoch) }),
  )
  /** Collects an epoch proof quote if there is an epoch to prove, and submits it to the L1 contract. */
  protected async claimEpochProofRightIfAvailable(slotNumber: bigint) {
    const proofQuote = await this.createProofClaimForPreviousEpoch(slotNumber);
    if (proofQuote === undefined) {
      return;
    }

    const epoch = proofQuote.payload.epochToProve;
    const ctx = { slotNumber, epoch, quote: proofQuote.toInspect() };
    this.log.verbose(`Claiming proof right for epoch ${epoch}`, ctx);
    const success = await this.publisher.claimEpochProofRight(proofQuote);
    if (!success) {
      throw new Error(`Failed to claim proof right for epoch ${epoch}`);
    }
    this.log.info(`Claimed proof right for epoch ${epoch}`, ctx);
    return epoch;
  }

  /**
   * Returns whether all dependencies have caught up.
   * We don't check against the previous block submitted since it may have been reorg'd out.
   * @returns Boolean indicating if our dependencies are synced to the latest block.
   */
  protected async isBlockSynced() {
    const syncedBlocks = await Promise.all([
      this.worldState.status().then((s: WorldStateSynchronizerStatus) => s.syncedToL2Block),
      this.l2BlockSource.getL2Tips().then(t => t.latest),
      this.p2pClient.getStatus().then(s => s.syncedToL2Block.number),
      this.l1ToL2MessageSource.getBlockNumber(),
    ] as const);
    const [worldState, l2BlockSource, p2p, l1ToL2MessageSource] = syncedBlocks;
    const result =
      // check that world state has caught up with archiver
      // note that the archiver reports undefined hash for the genesis block
      // because it doesn't have access to world state to compute it (facepalm)
      (l2BlockSource.hash === undefined || worldState.hash === l2BlockSource.hash) &&
      // and p2p client and message source are at least at the same block
      // this should change to hashes once p2p client handles reorgs
      // and once we stop pretending that the l1tol2message source is not
      // just the archiver under a different name
      p2p >= l2BlockSource.number &&
      l1ToL2MessageSource >= l2BlockSource.number;

    this.log.debug(`Sequencer sync check ${result ? 'succeeded' : 'failed'}`, {
      worldStateNumber: worldState.number,
      worldStateHash: worldState.hash,
      l2BlockSourceNumber: l2BlockSource.number,
      l2BlockSourceHash: l2BlockSource.hash,
      p2pNumber: p2p,
      l1ToL2MessageSourceNumber: l1ToL2MessageSource,
    });
    return result;
  }

  private getSlotStartTimestamp(slotNumber: number | bigint): number {
    return Number(this.l1Constants.l1GenesisTime) + Number(slotNumber) * this.l1Constants.slotDuration;
  }

  private getSecondsIntoSlot(slotNumber: number | bigint): number {
    const slotStartTimestamp = this.getSlotStartTimestamp(slotNumber);
    return Number((this.dateProvider.now() / 1000 - slotStartTimestamp).toFixed(3));
  }

  get aztecSlotDuration() {
    return this.l1Constants.slotDuration;
  }

  get coinbase(): EthAddress {
    return this._coinbase;
  }

  get feeRecipient(): AztecAddress {
    return this._feeRecipient;
  }
}
