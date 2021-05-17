/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Emitter } from 'vs/base/common/event';
import { VSBufferReadableStream } from 'vs/base/common/buffer';
import { IFileWorkingCopyModel, IFileWorkingCopyModelContentChangedEvent, IFileWorkingCopyModelFactory } from 'vs/workbench/services/workingCopy/common/fileWorkingCopy';
import { IWorkingCopy, IWorkingCopyBackup, WorkingCopyCapabilities } from 'vs/workbench/services/workingCopy/common/workingCopy';
import { Disposable, IDisposable } from 'vs/base/common/lifecycle';
import { URI } from 'vs/base/common/uri';
import { Schemas } from 'vs/base/common/network';
import { IWorkingCopyService } from 'vs/workbench/services/workingCopy/common/workingCopyService';
import { CancellationToken } from 'vs/base/common/cancellation';
import { ISaveOptions } from 'vs/workbench/common/editor';
import { raceCancellation } from 'vs/base/common/async';
import { ILogService } from 'vs/platform/log/common/log';
import { IWorkingCopyBackupService } from 'vs/workbench/services/workingCopy/common/workingCopyBackup';
import { emptyStream } from 'vs/base/common/stream';

export interface IUntitledFileWorkingCopyModelFactory<T extends IUntitledFileWorkingCopyModel> extends IFileWorkingCopyModelFactory<T> { }

export interface IUntitledFileWorkingCopyModel extends IFileWorkingCopyModel {
	readonly onDidChangeContent: Event<IUntitledFileWorkingCopyModelContentChangedEvent>;
}

export interface IUntitledFileWorkingCopyModelContentChangedEvent extends IFileWorkingCopyModelContentChangedEvent {

	/**
	 * Flag that indicates that the content change
	 * resulted in empty contents. A untitled file
	 * working copy without contents may be marked
	 * as non-dirty.
	 */
	readonly isEmpty: boolean;
}

export interface IUntitledFileWorkingCopy<T extends IUntitledFileWorkingCopyModel> extends IWorkingCopy, IDisposable {

	/**
	 * Emits an event when this untitled model is reverted.
	 */
	readonly onDidRevert: Event<void>;

	/**
	 * An event for when the file working copy has been disposed.
	 */
	readonly onWillDispose: Event<void>;

	/**
	 * Provides access to the underlying model of this untitled
	 * file based working copy. As long as the untitled file working
	 * copy has not been resolved, the model is `undefined`.
	 */
	readonly model: T | undefined;

	/**
	 * Whether this untitled file working copy model has an associated file path.
	 */
	readonly hasAssociatedFilePath: boolean;

	/**
	 * Resolves an untitled file working copy.
	 */
	resolve(): Promise<void>;
}

export interface IResolvedUntitledFileWorkingCopy<T extends IUntitledFileWorkingCopyModel> extends IUntitledFileWorkingCopy<T> {

	/**
	 * A resolved untitled file working copy has a resolved model `T`.
	 */
	readonly model: T;
}

export class UntitledFileWorkingCopy<T extends IUntitledFileWorkingCopyModel> extends Disposable implements IUntitledFileWorkingCopy<T>  {

	readonly capabilities: WorkingCopyCapabilities = WorkingCopyCapabilities.Untitled;

	private _model: T | undefined = undefined;
	get model(): T | undefined { return this._model; }

	//#region Events

	private readonly _onDidChangeContent = this._register(new Emitter<void>());
	readonly onDidChangeContent = this._onDidChangeContent.event;

	private readonly _onDidChangeDirty = this._register(new Emitter<void>());
	readonly onDidChangeDirty = this._onDidChangeDirty.event;

	private readonly _onDidRevert = this._register(new Emitter<void>());
	readonly onDidRevert = this._onDidRevert.event;

	private readonly _onWillDispose = this._register(new Emitter<void>());
	readonly onWillDispose = this._onWillDispose.event;

	//#endregion

	constructor(
		readonly typeId: string,
		readonly resource: URI,
		readonly name: string,
		readonly hasAssociatedFilePath: boolean,
		private readonly initialValue: VSBufferReadableStream | undefined,
		private readonly modelFactory: IUntitledFileWorkingCopyModelFactory<T>,
		@IWorkingCopyService workingCopyService: IWorkingCopyService,
		@IWorkingCopyBackupService private readonly workingCopyBackupService: IWorkingCopyBackupService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		if (resource.scheme !== Schemas.untitled) {
			throw new Error(`The untitled file working copy resource ${this.resource.toString(true)} is not using untitled as scheme.`);
		}

		// Make known to working copy service
		this._register(workingCopyService.registerWorkingCopy(this));
	}

	//#region Dirty

	private dirty = this.hasAssociatedFilePath || !!this.initialValue;

	isDirty(): boolean {
		return this.dirty;
	}

	private setDirty(dirty: boolean): void {
		if (this.dirty === dirty) {
			return;
		}

		this.dirty = dirty;
		this._onDidChangeDirty.fire();
	}

	//#endregion


	//#region Resolve

	async resolve(): Promise<void> {
		this.trace('[untitled file working copy] resolve()');

		if (this.isResolved()) {
			this.trace('[untitled file working copy] resolve() - exit (already resolved)');

			// return early if the untitled file working copy is already
			// resolved assuming that the contents have meanwhile changed
			// in the underlying model. we only resolve untitled once.
			return;
		}

		let untitledContents: VSBufferReadableStream;

		// Check for backups or use initial value or empty
		const backup = await this.workingCopyBackupService.resolve(this);
		if (backup) {
			this.trace('[untitled file working copy] resolve() - with backup');

			untitledContents = backup.value;
		} else if (this.initialValue) {
			this.trace('[untitled file working copy] resolve() - with initial contents');

			untitledContents = this.initialValue;
		} else {
			this.trace('[untitled file working copy] resolve() - empty');

			untitledContents = emptyStream();
		}

		// Create model
		await this.doCreateModel(untitledContents);

		// Untitled associated to file path are dirty right away as well as untitled with content
		this.setDirty(this.hasAssociatedFilePath || !!backup || !!this.initialValue);

		// If we have initial contents, make sure to emit this
		// as the appropiate events to the outside.
		if (!!backup || this.initialValue) {
			this._onDidChangeContent.fire();
		}
	}

	private async doCreateModel(contents: VSBufferReadableStream): Promise<void> {
		this.trace('[untitled file working copy] doCreateModel()');

		// Create model and dispose it when we get disposed
		this._model = this._register(await this.modelFactory.createModel(this.resource, contents, CancellationToken.None));

		// Model listeners
		this.installModelListeners(this._model);
	}

	private installModelListeners(model: IUntitledFileWorkingCopyModel): void {

		// Content Change
		this._register(model.onDidChangeContent(e => this.onModelContentChanged(e)));

		// Lifecycle
		this._register(model.onWillDispose(() => this.dispose()));
	}

	private onModelContentChanged(e: IUntitledFileWorkingCopyModelContentChangedEvent): void {

		// Mark the untitled file working copy as non-dirty once its
		// content becomes empty and we do not have an associated
		// path set. we never want dirty indicator in that case.
		if (!this.hasAssociatedFilePath && e.isEmpty) {
			this.setDirty(false);
		}

		// Turn dirty otherwise
		else {
			this.setDirty(true);
		}

		// Emit as general content change event
		this._onDidChangeContent.fire();
	}

	isResolved(): this is IResolvedUntitledFileWorkingCopy<T> {
		return !!this.model;
	}

	//#endregion


	//#region Backup

	async backup(token: CancellationToken): Promise<IWorkingCopyBackup> {

		// Fill in content if we are resolved
		let content: VSBufferReadableStream | undefined = undefined;
		if (this.isResolved()) {
			content = await raceCancellation(this.model.snapshot(token), token);
		}

		return { content };
	}

	//#endregion


	//#region Save

	async save(options?: ISaveOptions): Promise<boolean> {
		this.trace('[untitled file working copy] save() - enter');

		// TODO needs to extract the code for bringing up save dialog
		// or use the associated file path as target
		// Also, who is disposing the untitled after save and open the
		// new editor?

		await this.revert();

		return true;
	}

	//#endregion


	//#region Revert

	async revert(): Promise<void> {
		this.trace('[untitled file working copy] revert()');

		// No longer dirty
		this.setDirty(false);

		// Emit as event
		this._onDidRevert.fire();

		// A reverted untitled file working copy is invalid
		// because it has no actual source on disk to revert to.
		// As such we dispose the model.
		this.dispose();
	}

	//#endregion

	override dispose(): void {
		this.trace('[untitled file working copy] dispose()');

		this._onWillDispose.fire();

		super.dispose();
	}

	private trace(msg: string): void {
		this.logService.trace(msg, this.resource.toString(true), this.typeId);
	}
}
