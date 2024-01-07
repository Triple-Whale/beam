/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as runnerApi from "../proto/beam_runner_api";
import * as urns from "../internal/urns";

import { GeneralObjectCoder } from "../coders/js_coders";
import { PCollection } from "../pvalue";
import { Pipeline } from "../internal/pipeline";
import { PTransform, withName, extractName } from "./transform";
import { WindowedValue } from "../values";

/**
 * The interface used to apply an elementwise MappingFn to a PCollection.
 *
 * For simple transformations, `PCollection.map` or `PCollection.flatMap`
 * may be simpler to use.
 *
 * See also https://beam.apache.org/documentation/programming-guide/#pardo
 */
export interface LocalDoFn<InputT, OutputT, ContextT = undefined> {
  /**
   * If provided, the default name to use for this operation.
   */
  beamName?: string;

  /**
   * The name its exported under
   */
  exportName: string;

  /**
   * Process a single element from the PCollection, returning an iterable
   * of zero or more result elements.
   *
   * Also takes as input an optional context element which has the same
   * type as was passed into the parDo at construction time (but which is
   * now "activated" in the sense that side inputs, metrics, etc. are
   * available with runtime values/effects).
   */
  process: (element: InputT, context: ContextT) => Iterable<OutputT> | void;

  /**
   * Called once at the start of every bundle, before any `process()` calls.
   *
   * This can be used to amortize any expensive initialization.
   */
  startBundle?: (context: ContextT) => void;

  // TODO: (API) Re-consider this API.
  /**
   * Called once at the end of every bundle, after any `process()` calls.
   *
   * This can be used to clean up expensive initialization and/or flush any
   * elements that were buffered.
   */
  finishBundle?: (context: ContextT) => Iterable<WindowedValue<OutputT>> | void;
}

// TODO: (API) Do we need an AsyncDoFn (and async[Flat]Map) to be able to call
// async functions in the body of the fns. Or can they always be Async?
// The latter seems to have perf issues.
// (For PTransformClasss, it's a major usability issue, but maybe we can always
// await when calling user code.  OTOH, I don't know what the performance
// impact would be for creating promises for every element of every operation
// which is typically a very performance critical spot to optimize.)

// TODO: (Typescript) Can the context arg be optional iff ContextT is undefined?
/**
 * Creates a PTransform that applies a `DoFn` to a PCollection.
 */
export function localParDo<InputT, OutputT, ContextT = undefined>(
  doFn: LocalDoFn<InputT, OutputT, ContextT>,
  context: ContextT = undefined!
): PTransform<PCollection<InputT>, PCollection<OutputT>> {
  if (extractContext(doFn)) {
    context = { ...extractContext(doFn), ...context };
  }
  function expandInternal(
    input: PCollection<InputT>,
    pipeline: Pipeline,
    transformProto: runnerApi.PTransform
  ) {
    // Extract and populate side inputs from the context.
    const sideInputs = {};
    var contextCopy;
    if (typeof context === "object") {
      contextCopy = Object.create(context as Object) as any;
      const components = pipeline.context.components;
      for (const [name, value] of Object.entries(context as Object)) {
        if (value instanceof SideInputParam) {
          const inputName = "side." + name;
          transformProto.inputs[inputName] = value.pcoll.getId();
          contextCopy[name] = copySideInputWithId(value, inputName);
          const mainWindowingStrategyId =
            components.pcollections[input.getId()].windowingStrategyId;
          const sideWindowingStrategyId =
            components.pcollections[transformProto.inputs[inputName]]
              .windowingStrategyId;
          const sideWindowingStrategy =
            components.windowingStrategies[sideWindowingStrategyId];
          const isGlobalSide =
            sideWindowingStrategy.windowFn!.urn ==
            "beam:window_fn:global_windows:v1";
          sideInputs[inputName] = {
            accessPattern: {
              urn: value.accessor.accessPattern,
              payload: new Uint8Array(),
            },
            // TODO: (Cleanup) The viewFn is stored in the side input object.
            // Unclear what benefit there is to putting it here.
            viewFn: { urn: "unused", payload: new Uint8Array() },
            // TODO: (Extension) Possibly place this in the accessor.
            windowMappingFn: {
              urn: isGlobalSide
                ? urns.GLOBAL_WINDOW_MAPPING_FN_URN
                : mainWindowingStrategyId === sideWindowingStrategyId
                ? urns.IDENTITY_WINDOW_MAPPING_FN_URN
                : urns.ASSIGN_MAX_TIMESTAMP_WINDOW_MAPPING_FN_URN,
              value: new Uint8Array(),
            },
          };
        } else {
          contextCopy[name] = value;
        }
      }
    } else {
      contextCopy = context;
    }

    // Now finally construct the proto.
    transformProto.spec = runnerApi.FunctionSpec.create({
      urn: localParDo.urn,
      payload: runnerApi.ParDoPayload.toBinary(
        runnerApi.ParDoPayload.create({
          doFn: runnerApi.FunctionSpec.create({
            urn: urns.LOCAL_DOFN_EXPORT_NAME,
            payload: new TextEncoder().encode(doFn.exportName),
          }),
          sideInputs: sideInputs,
        })
      ),
    });

    // For the ParDo output coder, we use a GeneralObjectCoder, which is a Javascript-specific
    // coder to encode the various types that exist in JS.
    // TODO: (Types) Should there be a way to specify, or better yet infer, the coder to use?
    return pipeline.createPCollectionInternal<OutputT>(
      new GeneralObjectCoder()
    );
  }

  return withName(
    `parDo(${extractName(doFn.beamName || doFn.exportName)})`,
    expandInternal
  );
}

// TODO: (Cleanup) use runnerApi.StandardPTransformClasss_Primitives.PAR_DO.urn.
/** @internal */
localParDo.urn = "beam:transform:pardo:v1";

/** @internal */
function extractContext(fn) {
  return fn.beamPardoContextSpec;
}

/**
 * This is the root class of special parameters that can be provided in the
 * context of a map or DoFn.process method.
 */
class ParDoParam {
  // Provided externally.
  /** @internal */
  protected provider: ParamProvider | undefined;

  /** @internal */
  constructor(readonly parDoParamName: string) {}
}

/**
 * At runtime, one can invoke the special `lookup` method to retrieve the
 * relevant value associated with the currently-being-processed element.
 */
class ParDoLookupParam<T> extends ParDoParam {
  // TODO: Nameing "get" seems to be special.
  lookup(): T {
    if (this.provider === undefined) {
      throw new Error("Cannot be called outside of a DoFn's process method.");
    }

    return this.provider.lookup(this);
  }
}

/**
 * At runtime, one can invoke the special `update` method to update the
 * relevant value associated with the currently-being-processed element.
 */
class ParDoUpdateParam<T> extends ParDoParam {
  update(value: T): void {
    if (this.provider === undefined) {
      throw new Error("Cannot be called outside of a DoFn's process method.");
    }

    this.provider.update(this, value);
  }
}

/**
 * This is the magic class that wires up the ParDoParams to their values
 * at runtime.
 *
 * @internal
 */
interface ParamProvider {
  lookup<T>(param: ParDoLookupParam<T>): T;
  update<T>(param: ParDoUpdateParam<T>, value: T): void;
}

interface SideInputAccessor<PCollT, AccessorT, ValueT> {
  // This should be a value of runnerApi.StandardSideInputTypes, and specifies
  // the relationship between PCollT (the type fo the PCollection's elements)
  // and AccessorT (the type returned when fetching side inputs).
  accessPattern: string;
  // This transforms the runner type into the user's type.
  toValue: (AccessorT) => ValueT;
}

// TODO: (Extension) Support side inputs that are composites of multiple more
// primitive side inputs.
/**
 * Used to access side inputs corresponding to a given element from within a
 * `process()` method.
 *
 * See also https://beam.apache.org/documentation/programming-guide/#side-inputs
 */
class SideInputParam<
  PCollT,
  AccessorT,
  ValueT
> extends ParDoLookupParam<ValueT> {
  // Populated by user.
  pcoll: PCollection<PCollT>;
  // Typically populated by subclass.
  accessor: SideInputAccessor<PCollT, AccessorT, ValueT>;

  constructor(
    pcoll: PCollection<PCollT>,
    accessor: SideInputAccessor<PCollT, AccessorT, ValueT>
  ) {
    super("sideInput");
    this.pcoll = pcoll;
    this.accessor = accessor;
  }

  // Internal. Should match the id of the side input in the proto.
  // TODO: (Cleanup) Rename to tag for consistency?
  sideInputId: string;
}

function copySideInputWithId<PCollT, AccessorT, ValueT>(
  sideInput: SideInputParam<PCollT, AccessorT, ValueT>,
  id: string
): SideInputParam<PCollT, AccessorT, ValueT> {
  const copy = Object.create(sideInput);
  copy.sideInputId = id;
  delete copy.pcoll;
  return copy;
}
