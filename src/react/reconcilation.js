/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */

/* @flow */

import { Realm, type Effects, type SideEffectType } from "../realm.js";
import {
  AbstractObjectValue,
  AbstractValue,
  ArrayValue,
  BooleanValue,
  BoundFunctionValue,
  ECMAScriptSourceFunctionValue,
  FunctionValue,
  NullValue,
  NumberValue,
  ObjectValue,
  StringValue,
  SymbolValue,
  Value,
  UndefinedValue,
} from "../values/index.js";
import { ReactStatistics, type ReactEvaluatedNode } from "../serializer/types.js";
import {
  createInternalReactElement,
  createReactEvaluatedNode,
  doNotOptimizeComponent,
  evaluateWithNestedParentEffects,
  flagPropsWithNoPartialKeyOrRef,
  flattenChildren,
  getComponentName,
  getComponentTypeFromRootValue,
  getLocationFromValue,
  getProperty,
  getReactSymbol,
  getValueFromFunctionCall,
  isReactElement,
  mapArrayValue,
  sanitizeReactElementForFirstRenderOnly,
  valueIsClassComponent,
  valueIsFactoryClassComponent,
  valueIsKnownReactAbstraction,
  valueIsLegacyCreateClassComponent,
} from "./utils";
import { Get } from "../methods/index.js";
import invariant from "../invariant.js";
import { Properties } from "../singletons.js";
import { FatalError, CompilerDiagnostic } from "../errors.js";
import { getValueWithBranchingLogicApplied, type BranchStatusEnum } from "./branching.js";
import * as t from "babel-types";
import { Completion } from "../completions.js";
import {
  getInitialProps,
  getInitialContext,
  createClassInstance,
  createSimpleClassInstance,
  evaluateClassConstructor,
  createClassInstanceForFirstRenderOnly,
  applyGetDerivedStateFromProps,
} from "./components.js";
import {
  DoNotOptimize,
  ExpectedBailOut,
  NewComponentTreeBranch,
  ReconcilerFatalError,
  SimpleClassBailOut,
  UnsupportedSideEffect,
} from "./errors.js";
import { Logger } from "../utils/logger.js";
import type { ClassComponentMetadata, PropertyBinding, ReactComponentTreeConfig, ReactHint } from "../types.js";
import type { Binding } from "../environment.js";

type ComponentResolutionStrategy =
  | "NORMAL"
  | "FRAGMENT"
  | "RELAY_QUERY_RENDERER"
  | "CONTEXT_PROVIDER"
  | "CONTEXT_CONSUMER"
  | "FORWARD_REF";

export type OptimizedClosure = {
  evaluatedNode: ReactEvaluatedNode,
  func: ECMAScriptSourceFunctionValue | BoundFunctionValue,
  nestedEffects: Array<Effects>,
  componentType: Value | null,
  context: ObjectValue | AbstractObjectValue | null,
};

export type BranchReactComponentTree = {
  context: ObjectValue | AbstractObjectValue | null,
  evaluatedNode: ReactEvaluatedNode,
  props: ObjectValue | AbstractObjectValue | null,
  rootValue: ECMAScriptSourceFunctionValue | AbstractValue,
};

export type ComponentTreeState = {
  componentType: void | ECMAScriptSourceFunctionValue,
  contextTypes: Set<string>,
  deadEnds: number,
  status: "SIMPLE" | "COMPLEX",
  contextNodeReferences: Map<ObjectValue | AbstractObjectValue, number>,
};

function setContextCurrentValue(contextObject: ObjectValue | AbstractObjectValue, value: Value): void {
  if (contextObject instanceof AbstractObjectValue && !contextObject.values.isTop()) {
    let elements = contextObject.values.getElements();
    if (elements && elements.size > 0) {
      contextObject = Array.from(elements)[0];
    } else {
      // intentionally left in
      invariant(false, "TODO: should we hit this?");
    }
  }
  if (!(contextObject instanceof ObjectValue)) {
    throw new ExpectedBailOut("cannot set currentValue on an abstract context consumer");
  }
  let binding = contextObject.properties.get("currentValue");

  if (binding && binding.descriptor) {
    binding.descriptor.value = value;
  } else {
    invariant(false, "setContextCurrentValue failed to set the currentValue");
  }
}

export class Reconciler {
  constructor(
    realm: Realm,
    componentTreeConfig: ReactComponentTreeConfig,
    statistics: ReactStatistics,
    logger?: Logger
  ) {
    this.realm = realm;
    this.statistics = statistics;
    this.logger = logger;
    this.componentTreeState = this._createComponentTreeState();
    this.alreadyEvaluatedRootNodes = new Map();
    this.alreadyEvaluatedNestedClosures = new Set();
    this.componentTreeConfig = componentTreeConfig;
    this.nestedOptimizedClosures = [];
    this.branchedComponentTrees = [];
  }

  realm: Realm;
  statistics: ReactStatistics;
  logger: void | Logger;
  componentTreeState: ComponentTreeState;
  alreadyEvaluatedRootNodes: Map<ECMAScriptSourceFunctionValue, ReactEvaluatedNode>;
  alreadyEvaluatedNestedClosures: Set<FunctionValue>;
  componentTreeConfig: ReactComponentTreeConfig;
  currentEffectsStack: Array<Effects>;
  nestedOptimizedClosures: Array<OptimizedClosure>;
  branchedComponentTrees: Array<BranchReactComponentTree>;

  resolveReactComponentTree(
    componentType: ECMAScriptSourceFunctionValue,
    props: ObjectValue | AbstractObjectValue | null,
    context: ObjectValue | AbstractObjectValue | null,
    evaluatedRootNode: ReactEvaluatedNode
  ): Effects {
    const resolveComponentTree = () => {
      try {
        let initialProps = props || getInitialProps(this.realm, componentType);
        let initialContext = context || getInitialContext(this.realm, componentType);
        this.alreadyEvaluatedRootNodes.set(componentType, evaluatedRootNode);
        let { result } = this._resolveComponent(componentType, initialProps, initialContext, "ROOT", evaluatedRootNode);
        this.statistics.optimizedTrees++;
        return result;
      } catch (error) {
        this._handleComponentTreeRootFailure(error, evaluatedRootNode);
        // flow belives we can get here, when it should never be possible
        invariant(false, "resolveReactComponentTree error not handled correctly");
      }
    };

    let effects = this.realm.wrapInGlobalEnv(() =>
      this.realm.evaluatePure(
        () =>
          this.realm.evaluateForEffects(
            resolveComponentTree,
            /*state*/ null,
            `react component: ${getComponentName(this.realm, componentType)}`
          ),
        this._handleReportedSideEffect
      )
    );
    this._handleNestedOptimizedClosuresFromEffects(effects, evaluatedRootNode);
    return effects;
  }

  _handleNestedOptimizedClosuresFromEffects(effects: Effects, evaluatedNode: ReactEvaluatedNode) {
    for (let { nestedEffects } of this.nestedOptimizedClosures) {
      if (nestedEffects.length === 0) {
        nestedEffects.push(...nestedEffects, effects);
      }
    }
  }

  resolveNestedOptimizedClosure(
    func: ECMAScriptSourceFunctionValue | BoundFunctionValue,
    nestedEffects: Array<Effects>,
    componentType: Value | null,
    context: ObjectValue | AbstractObjectValue | null,
    evaluatedNode: ReactEvaluatedNode
  ): Effects {
    const resolveOptimizedClosure = () => {
      let baseObject = this.realm.$GlobalEnv.environmentRecord.WithBaseObject();
      // we want to optimize the function that is bound
      if (func instanceof BoundFunctionValue) {
        // we want to set the "this" to be the bound object
        // for firstRender this will optimize the function
        // for updates, "this" will be intrinsic, so either way
        // they should both work
        baseObject = func.$BoundThis;
        invariant(func.$BoundTargetFunction instanceof ECMAScriptSourceFunctionValue);
        func = func.$BoundTargetFunction;
      }
      let numArgs = func.getLength();
      let args = [];
      let targetFunc = func;

      this.alreadyEvaluatedNestedClosures.add(func);
      invariant(targetFunc instanceof ECMAScriptSourceFunctionValue);
      let params = targetFunc.$FormalParameters;
      if (numArgs && numArgs > 0 && params) {
        for (let parameterId of params) {
          if (t.isIdentifier(parameterId)) {
            // Create an AbstractValue similar to __abstract being called
            args.push(
              AbstractValue.createAbstractArgument(
                this.realm,
                ((parameterId: any): BabelNodeIdentifier).name,
                targetFunc.expressionLocation
              )
            );
          } else {
            this.realm.handleError(
              new CompilerDiagnostic(
                "Non-identifier args to additional functions unsupported",
                targetFunc.expressionLocation,
                "PP1005",
                "FatalError"
              )
            );
            throw new FatalError("Non-identifier args to additional functions unsupported");
          }
        }
      }
      try {
        invariant(
          baseObject instanceof ObjectValue ||
            baseObject instanceof AbstractObjectValue ||
            baseObject instanceof UndefinedValue
        );
        let value = getValueFromFunctionCall(this.realm, func, baseObject, args);
        invariant(componentType instanceof Value);
        invariant(context instanceof ObjectValue || context instanceof AbstractObjectValue);
        let result = this._resolveDeeply(componentType, value, context, "NEW_BRANCH", evaluatedNode);
        this.statistics.optimizedNestedClosures++;
        return result;
      } catch (error) {
        this._handleComponentTreeRootFailure(error, evaluatedNode);
        // flow belives we can get here, when it should never be possible
        invariant(false, "resolveNestedOptimizedClosure error not handled correctly");
      }
    };

    let effects = this.realm.wrapInGlobalEnv(() =>
      this.realm.evaluatePure(() =>
        evaluateWithNestedParentEffects(this.realm, nestedEffects, () =>
          this.realm.evaluateForEffects(resolveOptimizedClosure, /*state*/ null, `react nested optimized closure`)
        )
      )
    );
    this._handleNestedOptimizedClosuresFromEffects(effects, evaluatedNode);
    return effects;
  }

  clearComponentTreeState(): void {
    this.componentTreeState = this._createComponentTreeState();
  }

  _queueOptimizedClosure(
    func: ECMAScriptSourceFunctionValue | BoundFunctionValue,
    evaluatedNode: ReactEvaluatedNode,
    componentType: Value | null,
    context: ObjectValue | AbstractObjectValue | null
  ): void {
    if (this.realm.react.optimizeNestedFunctions) {
      this.nestedOptimizedClosures.push({
        evaluatedNode,
        func,
        nestedEffects: [],
        componentType,
        context,
      });
    }
  }

  _queueNewComponentTree(
    rootValue: Value,
    evaluatedNode: ReactEvaluatedNode,
    props?: ObjectValue | AbstractObjectValue | null = null,
    context?: ObjectValue | AbstractObjectValue | null = null
  ): void {
    if (rootValue instanceof SymbolValue) {
      return;
    }
    invariant(rootValue instanceof ECMAScriptSourceFunctionValue || rootValue instanceof AbstractValue);
    this.componentTreeState.deadEnds++;
    let componentType = getComponentTypeFromRootValue(this.realm, rootValue);
    if (componentType !== null && !this.hasEvaluatedRootNode(componentType, evaluatedNode)) {
      this.branchedComponentTrees.push({
        context,
        evaluatedNode,
        props,
        rootValue,
      });
    }
  }

  _resolveComplexClassComponent(
    componentType: ECMAScriptSourceFunctionValue,
    props: ObjectValue | AbstractObjectValue,
    context: ObjectValue | AbstractObjectValue,
    classMetadata: ClassComponentMetadata,
    branchStatus: BranchStatusEnum,
    evaluatedNode: ReactEvaluatedNode
  ): Value {
    if (branchStatus !== "ROOT") {
      // if the tree is simple and we're not in a branch, we can make this tree complex
      // and make this complex component the root
      let evaluatedComplexNode = this.alreadyEvaluatedRootNodes.get(componentType);
      if (
        branchStatus === "NO_BRANCH" &&
        this.componentTreeState.status === "SIMPLE" &&
        evaluatedComplexNode &&
        evaluatedComplexNode.status !== "RENDER_PROPS"
      ) {
        this.componentTreeState.componentType = componentType;
      } else {
        this._queueNewComponentTree(componentType, evaluatedNode);
        evaluatedNode.status = "NEW_TREE";
        throw new NewComponentTreeBranch(evaluatedNode);
      }
    }
    this.componentTreeState.status = "COMPLEX";
    // create a new instance of this React class component
    let instance = createClassInstance(this.realm, componentType, props, context, classMetadata);
    // get the "render" method off the instance
    let renderMethod = Get(this.realm, instance, "render");
    invariant(renderMethod instanceof ECMAScriptSourceFunctionValue);
    // the render method doesn't have any arguments, so we just assign the context of "this" to be the instance
    return getValueFromFunctionCall(this.realm, renderMethod, instance, []);
  }

  _resolveSimpleClassComponent(
    componentType: ECMAScriptSourceFunctionValue,
    props: ObjectValue | AbstractObjectValue,
    context: ObjectValue | AbstractObjectValue,
    branchStatus: BranchStatusEnum,
    evaluatedNode: ReactEvaluatedNode
  ): Value {
    // create a new simple instance of this React class component
    let instance = createSimpleClassInstance(this.realm, componentType, props, context);
    // get the "render" method off the instance
    let renderMethod = Get(this.realm, instance, "render");
    invariant(renderMethod instanceof ECMAScriptSourceFunctionValue);
    // the render method doesn't have any arguments, so we just assign the context of "this" to be the instance
    return getValueFromFunctionCall(this.realm, renderMethod, instance, []);
  }

  _resolveFunctionalComponent(
    componentType: ECMAScriptSourceFunctionValue,
    props: ObjectValue | AbstractObjectValue,
    context: ObjectValue | AbstractObjectValue,
    evaluatedNode: ReactEvaluatedNode
  ) {
    return getValueFromFunctionCall(this.realm, componentType, this.realm.intrinsics.undefined, [props, context]);
  }

  _getClassComponentMetadata(
    componentType: ECMAScriptSourceFunctionValue,
    props: ObjectValue | AbstractObjectValue,
    context: ObjectValue | AbstractObjectValue
  ): ClassComponentMetadata {
    if (this.realm.react.classComponentMetadata.has(componentType)) {
      let classMetadata = this.realm.react.classComponentMetadata.get(componentType);
      invariant(classMetadata);
      return classMetadata;
    }
    // get all this assignments in the constructor
    let classMetadata = evaluateClassConstructor(this.realm, componentType, props, context);
    this.realm.react.classComponentMetadata.set(componentType, classMetadata);
    return classMetadata;
  }

  _resolveContextProviderComponent(
    componentType: Value,
    reactElement: ObjectValue,
    context: ObjectValue | AbstractObjectValue,
    branchStatus: BranchStatusEnum,
    evaluatedNode: ReactEvaluatedNode
  ): Value {
    let typeValue = getProperty(this.realm, reactElement, "type");
    let propsValue = getProperty(this.realm, reactElement, "props");

    let evaluatedChildNode = createReactEvaluatedNode("NORMAL", "Context.Provider");
    evaluatedNode.children.push(evaluatedChildNode);
    this.statistics.componentsEvaluated++;
    invariant(typeValue instanceof ObjectValue || typeValue instanceof AbstractObjectValue);
    const contextConsumer = getProperty(this.realm, typeValue, "context");
    invariant(contextConsumer instanceof ObjectValue || contextConsumer instanceof AbstractObjectValue);
    let lastValueProp = getProperty(this.realm, contextConsumer, "currentValue");
    this._incremementReferenceForContextNode(contextConsumer);

    // if we have a value prop, set it
    if (propsValue instanceof ObjectValue || propsValue instanceof AbstractObjectValue) {
      let valueProp = Get(this.realm, propsValue, "value");
      setContextCurrentValue(contextConsumer, valueProp);
    }
    if (this.componentTreeConfig.firstRenderOnly) {
      if (propsValue instanceof ObjectValue) {
        let resolvedReactElement = this._resolveReactElementHostChildren(
          componentType,
          reactElement,
          context,
          branchStatus,
          evaluatedChildNode
        );
        let resolvedPropsValue = getProperty(this.realm, resolvedReactElement, "props");
        invariant(resolvedPropsValue instanceof ObjectValue || resolvedPropsValue instanceof AbstractObjectValue);
        invariant(lastValueProp instanceof Value);
        setContextCurrentValue(contextConsumer, lastValueProp);
        this._decremementReferenceForContextNode(contextConsumer);
        // if we no dead ends, we know the rest of the tree and can safely remove the provider
        if (this.componentTreeState.deadEnds === 0) {
          let childrenValue = Get(this.realm, resolvedPropsValue, "children");
          evaluatedChildNode.status = "INLINED";
          this.statistics.inlinedComponents++;
          return childrenValue;
        }
        return resolvedReactElement;
      }
    }
    let children = this._resolveReactElementHostChildren(
      componentType,
      reactElement,
      context,
      branchStatus,
      evaluatedChildNode
    );
    setContextCurrentValue(contextConsumer, lastValueProp);
    this._decremementReferenceForContextNode(contextConsumer);
    return children;
  }

  _decremementReferenceForContextNode(contextNode: ObjectValue | AbstractObjectValue): void {
    let references = this.componentTreeState.contextNodeReferences.get(contextNode);
    if (!references) {
      references = 0;
    } else {
      references--;
    }
    this.componentTreeState.contextNodeReferences.set(contextNode, references);
  }

  _incremementReferenceForContextNode(contextNode: ObjectValue | AbstractObjectValue): void {
    let references = this.componentTreeState.contextNodeReferences.get(contextNode);
    if (!references) {
      references = 1;
    } else {
      references++;
    }
    this.componentTreeState.contextNodeReferences.set(contextNode, references);
  }

  _hasReferenceForContextNode(contextNode: ObjectValue | AbstractObjectValue): boolean {
    if (this.componentTreeState.contextNodeReferences.has(contextNode)) {
      let references = this.componentTreeState.contextNodeReferences.get(contextNode);
      if (!references) {
        return false;
      }
      return references > 0;
    }
    return false;
  }

  _resolveContextConsumerComponent(
    componentType: Value,
    reactElement: ObjectValue,
    context: ObjectValue | AbstractObjectValue,
    evaluatedNode: ReactEvaluatedNode
  ): Value | void {
    let typeValue = getProperty(this.realm, reactElement, "type");
    let propsValue = getProperty(this.realm, reactElement, "props");
    let evaluatedChildNode = createReactEvaluatedNode("RENDER_PROPS", "Context.Consumer");
    evaluatedNode.children.push(evaluatedChildNode);

    if (propsValue instanceof ObjectValue || propsValue instanceof AbstractObjectValue) {
      // get the "render" prop child off the instance
      if (propsValue instanceof ObjectValue && propsValue.properties.has("children")) {
        let renderProp = getProperty(this.realm, propsValue, "children");

        this._findReactComponentTrees(propsValue, evaluatedChildNode, "NORMAL_FUNCTIONS");
        if (renderProp instanceof ECMAScriptSourceFunctionValue) {
          if (this.componentTreeConfig.firstRenderOnly) {
            if (typeValue instanceof ObjectValue || typeValue instanceof AbstractObjectValue) {
              // make sure this context is in our tree
              if (this._hasReferenceForContextNode(typeValue)) {
                let valueProp = Get(this.realm, typeValue, "currentValue");
                let result = getValueFromFunctionCall(this.realm, renderProp, this.realm.intrinsics.undefined, [
                  valueProp,
                ]);
                this.statistics.inlinedComponents++;
                this.statistics.componentsEvaluated++;
                evaluatedChildNode.status = "INLINED";
                return result;
              }
            }
          }
          this._queueOptimizedClosure(renderProp, evaluatedChildNode, componentType, context);
          return;
        } else {
          this._findReactComponentTrees(renderProp, evaluatedChildNode, "NESTED_CLOSURES");
        }
      }
    }
    this.componentTreeState.deadEnds++;
    return;
  }

  _resolveForwardRefComponent(
    componentType: Value,
    reactElement: ObjectValue,
    context: ObjectValue | AbstractObjectValue,
    branchStatus: BranchStatusEnum,
    evaluatedNode: ReactEvaluatedNode
  ): Value | void {
    let typeValue = getProperty(this.realm, reactElement, "type");
    let propsValue = getProperty(this.realm, reactElement, "props");
    let refValue = getProperty(this.realm, reactElement, "ref");
    invariant(typeValue instanceof AbstractValue || typeValue instanceof ObjectValue);
    let reactHint = this.realm.react.abstractHints.get(typeValue);

    invariant(reactHint !== undefined);
    let [forwardedComponent] = reactHint.args;
    let evaluatedChildNode = createReactEvaluatedNode("FORWARD_REF", getComponentName(this.realm, forwardedComponent));
    evaluatedNode.children.push(evaluatedChildNode);
    invariant(
      forwardedComponent instanceof ECMAScriptSourceFunctionValue,
      "expect React.forwardRef() to be passed function value"
    );
    let value = getValueFromFunctionCall(this.realm, forwardedComponent, this.realm.intrinsics.undefined, [
      propsValue,
      refValue,
    ]);
    return this._resolveDeeply(componentType, value, context, branchStatus, evaluatedChildNode);
  }

  _resolveRelayQueryRendererComponent(
    componentType: Value,
    reactElement: ObjectValue,
    context: ObjectValue | AbstractObjectValue,
    evaluatedNode: ReactEvaluatedNode
  ): Value | void {
    let typeValue = getProperty(this.realm, reactElement, "type");
    let propsValue = getProperty(this.realm, reactElement, "props");

    let evaluatedChildNode = createReactEvaluatedNode("RENDER_PROPS", getComponentName(this.realm, typeValue));
    evaluatedNode.children.push(evaluatedChildNode);

    if (propsValue instanceof ObjectValue || propsValue instanceof AbstractObjectValue) {
      // get the "render" prop
      if (propsValue instanceof ObjectValue && propsValue.properties.has("render")) {
        let renderProp = getProperty(this.realm, propsValue, "render");

        if (renderProp instanceof ECMAScriptSourceFunctionValue) {
          this._queueOptimizedClosure(renderProp, evaluatedChildNode, componentType, context);
        } else if (renderProp instanceof AbstractValue) {
          this._findReactComponentTrees(renderProp, evaluatedChildNode, "NESTED_CLOSURES", componentType, context);
        }
      }
      this._findReactComponentTrees(propsValue, evaluatedChildNode, "NORMAL_FUNCTIONS");
      return;
    }
    // this is the worst case, we were unable to find the render prop function
    // and won't be able to find any further components to evaluate as trees
    // because of that
    this.componentTreeState.deadEnds++;
  }

  _resolveClassComponent(
    componentType: ECMAScriptSourceFunctionValue,
    props: ObjectValue | AbstractObjectValue,
    context: ObjectValue | AbstractObjectValue,
    branchStatus: BranchStatusEnum,
    evaluatedNode: ReactEvaluatedNode
  ): Value {
    let value;

    let classMetadata = this._getClassComponentMetadata(componentType, props, context);
    let { instanceProperties, instanceSymbols } = classMetadata;

    // if there were no this assignments we can try and render it as a simple class component
    if (instanceProperties.size === 0 && instanceSymbols.size === 0) {
      // We first need to know what type of class component we're dealing with.
      // A "simple" class component is defined as:
      //
      // - having only a "render" method
      // - having no lifecycle events
      // - having no state
      // - having no instance variables
      //
      // the only things a class component should be able to access on "this" are:
      // - this.props
      // - this.context
      // - this._someRenderMethodX() etc
      //
      // Otherwise, the class component is a "complex" one.
      // To begin with, we don't know what type of component it is, so we try and render it as if it were
      // a simple component using the above heuristics. If an error occurs during this process, we assume
      // that the class wasn't simple, then try again with the "complex" heuristics.
      try {
        value = this._resolveSimpleClassComponent(componentType, props, context, branchStatus, evaluatedNode);
      } catch (error) {
        // if we get back a SimpleClassBailOut error, we know that this class component
        // wasn't a simple one and is likely to be a complex class component instead
        if (error instanceof SimpleClassBailOut) {
          // the component was not simple, so we continue with complex case
        } else {
          // else we rethrow the error
          throw error;
        }
      }
    }
    // handle the complex class component if there is not value
    if (value === undefined) {
      value = this._resolveComplexClassComponent(
        componentType,
        props,
        context,
        classMetadata,
        branchStatus,
        evaluatedNode
      );
    }
    return value;
  }

  _resolveClassComponentForFirstRenderOnly(
    componentType: ECMAScriptSourceFunctionValue,
    props: ObjectValue | AbstractObjectValue,
    context: ObjectValue | AbstractObjectValue,
    branchStatus: BranchStatusEnum,
    evaluatedNode: ReactEvaluatedNode
  ): Value {
    // create a new simple instance of this React class component
    let instance = createClassInstanceForFirstRenderOnly(this.realm, componentType, props, context, evaluatedNode);
    let getDerivedStateFromProps = Get(this.realm, componentType, "getDerivedStateFromProps");
    let getSnapshotBeforeUpdate = Get(this.realm, instance, "getSnapshotBeforeUpdate");

    // if either getDerivedStateFromProps or getSnapshotBeforeUpdate exist, then
    // we don't try and execute componentWillMount and UNSAFE_componentWillMount
    if (
      getDerivedStateFromProps !== this.realm.intrinsics.undefined ||
      getSnapshotBeforeUpdate !== this.realm.intrinsics.undefined
    ) {
      if (getDerivedStateFromProps instanceof ECMAScriptSourceFunctionValue && getDerivedStateFromProps.$Call) {
        applyGetDerivedStateFromProps(this.realm, getDerivedStateFromProps, instance, props);
      }
    } else {
      // get the "componentWillMount" and "render" methods off the instance
      let componentWillMount = Get(this.realm, instance, "componentWillMount");

      if (componentWillMount instanceof ECMAScriptSourceFunctionValue && componentWillMount.$Call) {
        componentWillMount.$Call(instance, []);
      }
      let unsafeComponentWillMount = Get(this.realm, instance, "UNSAFE_componentWillMount");

      if (unsafeComponentWillMount instanceof ECMAScriptSourceFunctionValue && unsafeComponentWillMount.$Call) {
        unsafeComponentWillMount.$Call(instance, []);
      }
    }
    let renderMethod = Get(this.realm, instance, "render");

    invariant(renderMethod instanceof ECMAScriptSourceFunctionValue);
    return getValueFromFunctionCall(this.realm, renderMethod, instance, []);
  }

  _resolveRelayContainer(
    reactHint: ReactHint,
    props: ObjectValue | AbstractObjectValue,
    context: ObjectValue | AbstractObjectValue,
    branchStatus: BranchStatusEnum,
    evaluatedNode: ReactEvaluatedNode
  ) {
    evaluatedNode.status = "INLINED";
    evaluatedNode.message = "RelayContainer";
    invariant(reactHint.firstRenderValue instanceof Value);
    // for better serialization, ensure context has the right abstract properties defined
    if (getProperty(this.realm, context, "relay") === this.realm.intrinsics.undefined) {
      let abstractRelayContext = AbstractValue.createAbstractObject(this.realm, "context.relay");
      let abstractRelayEnvironment = AbstractValue.createAbstractObject(this.realm, "context.relay.environment");
      let abstractRelayInternal = AbstractValue.createAbstractObject(
        this.realm,
        "context.relay.environment.unstable_internal"
      );
      Properties.Set(this.realm, context, "relay", abstractRelayContext, true);
      Properties.Set(this.realm, abstractRelayContext, "environment", abstractRelayEnvironment, true);
      Properties.Set(this.realm, abstractRelayEnvironment, "unstable_internal", abstractRelayInternal, true);
    }
    // add contextType to this component
    this.componentTreeState.contextTypes.add("relay");
    return this._resolveComponent(reactHint.firstRenderValue, props, context, branchStatus, evaluatedNode);
  }

  _resolveComponent(
    componentType: Value,
    props: ObjectValue | AbstractObjectValue,
    context: ObjectValue | AbstractObjectValue,
    branchStatus: BranchStatusEnum,
    evaluatedNode: ReactEvaluatedNode
  ) {
    if (doNotOptimizeComponent(this.realm, componentType)) {
      throw new DoNotOptimize("__reactCompilerDoNotOptimize flag detected");
    }
    this.statistics.componentsEvaluated++;
    if (valueIsKnownReactAbstraction(this.realm, componentType)) {
      invariant(componentType instanceof AbstractValue);
      let reactHint = this.realm.react.abstractHints.get(componentType);

      invariant(reactHint);
      if (
        typeof reactHint !== "string" &&
        reactHint.object === this.realm.fbLibraries.reactRelay &&
        this.componentTreeConfig.firstRenderOnly
      ) {
        return this._resolveRelayContainer(reactHint, props, context, branchStatus, evaluatedNode);
      }
      this._queueNewComponentTree(componentType, evaluatedNode);
      evaluatedNode.status = "NEW_TREE";
      evaluatedNode.message = "RelayContainer";
      throw new NewComponentTreeBranch(evaluatedNode);
    }
    invariant(componentType instanceof ECMAScriptSourceFunctionValue);
    let value;
    let childContext = context;

    // first we check if it's a legacy class component
    if (valueIsLegacyCreateClassComponent(this.realm, componentType)) {
      throw new ExpectedBailOut("components created with create-react-class are not supported");
    } else if (valueIsClassComponent(this.realm, componentType)) {
      if (this.componentTreeConfig.firstRenderOnly) {
        value = this._resolveClassComponentForFirstRenderOnly(
          componentType,
          props,
          context,
          branchStatus,
          evaluatedNode
        );
      } else {
        value = this._resolveClassComponent(componentType, props, context, branchStatus, evaluatedNode);
      }
    } else {
      value = this._resolveFunctionalComponent(componentType, props, context, evaluatedNode);
      if (valueIsFactoryClassComponent(this.realm, value)) {
        invariant(value instanceof ObjectValue);
        if (branchStatus !== "ROOT") {
          throw new ExpectedBailOut("non-root factory class components are not suppoted");
        } else {
          // TODO support factory components
          return {
            result: value,
            childContext,
          };
        }
      }
    }
    invariant(value !== undefined);
    return {
      result: this._resolveDeeply(
        componentType,
        value,
        context,
        branchStatus === "ROOT" ? "NO_BRANCH" : branchStatus,
        evaluatedNode
      ),
      childContext,
    };
  }

  _createComponentTreeState(): ComponentTreeState {
    return {
      componentType: undefined,
      contextTypes: new Set(),
      deadEnds: 0,
      status: "SIMPLE",
      contextNodeReferences: new Map(),
    };
  }

  _getComponentResolutionStrategy(value: Value): ComponentResolutionStrategy {
    // check if it's a ReactRelay.QueryRenderer
    if (this.realm.fbLibraries.reactRelay !== undefined) {
      let QueryRenderer = getProperty(this.realm, this.realm.fbLibraries.reactRelay, "QueryRenderer");
      if (value === QueryRenderer) {
        return "RELAY_QUERY_RENDERER";
      }
    }
    if (value === getReactSymbol("react.fragment", this.realm)) {
      return "FRAGMENT";
    }
    if (value instanceof AbstractValue && this.realm.react.abstractHints.has(value)) {
      let reactHint = this.realm.react.abstractHints.get(value);

      invariant(reactHint !== undefined);
      if (reactHint.object === this.realm.fbLibraries.react && reactHint.propertyName === "forwardRef") {
        return "FORWARD_REF";
      }
    }
    if ((value instanceof ObjectValue || value instanceof AbstractObjectValue) && value.kind !== "conditional") {
      let $$typeof = getProperty(this.realm, value, "$$typeof");

      if ($$typeof === getReactSymbol("react.context", this.realm)) {
        return "CONTEXT_CONSUMER";
      }
      if ($$typeof === getReactSymbol("react.provider", this.realm)) {
        return "CONTEXT_PROVIDER";
      }
    }
    return "NORMAL";
  }

  _resolveReactDomPortal(
    createPortalNode: AbstractValue,
    args: Array<Value>,
    componentType: Value,
    context: ObjectValue | AbstractObjectValue,
    branchStatus: BranchStatusEnum,
    evaluatedNode: ReactEvaluatedNode
  ) {
    let [reactPortalValue, domNodeValue] = args;
    let evaluatedChildNode = createReactEvaluatedNode("INLINED", "ReactDOM.createPortal");
    let resolvedReactPortalValue = this._resolveDeeply(
      componentType,
      reactPortalValue,
      context,
      branchStatus,
      evaluatedChildNode
    );
    evaluatedNode.children.push(evaluatedChildNode);
    if (resolvedReactPortalValue !== reactPortalValue) {
      this.statistics.inlinedComponents++;
      let reactDomValue = this.realm.fbLibraries.reactDom;
      invariant(reactDomValue instanceof ObjectValue);
      let reactDomPortalFunc = getProperty(this.realm, reactDomValue, "createPortal");
      return AbstractValue.createTemporalFromBuildFunction(
        this.realm,
        ObjectValue,
        [reactDomPortalFunc, resolvedReactPortalValue, domNodeValue],
        ([renderNode, ..._args]) => {
          return t.callExpression(renderNode, ((_args: any): Array<any>));
        }
      );
    }
    return createPortalNode;
  }

  _resolveAbstractConditionalValue(
    componentType: Value,
    condValue: AbstractValue,
    consequentVal: Value,
    alternateVal: Value,
    context: ObjectValue | AbstractObjectValue,
    evaluatedNode: ReactEvaluatedNode
  ) {
    let value = this.realm.evaluateWithAbstractConditional(
      condValue,
      () => {
        return this.realm.evaluateForEffects(
          () => this._resolveDeeply(componentType, consequentVal, context, "NEW_BRANCH", evaluatedNode),
          null,
          "_resolveAbstractConditionalValue consequent"
        );
      },
      () => {
        return this.realm.evaluateForEffects(
          () => this._resolveDeeply(componentType, alternateVal, context, "NEW_BRANCH", evaluatedNode),
          null,
          "_resolveAbstractConditionalValue alternate"
        );
      }
    );
    if (value instanceof AbstractValue && value.kind === "conditional") {
      return getValueWithBranchingLogicApplied(this.realm, consequentVal, alternateVal, value);
    }
    return value;
  }

  _resolveAbstractValue(
    componentType: Value,
    value: AbstractValue,
    context: ObjectValue | AbstractObjectValue,
    branchStatus: BranchStatusEnum,
    evaluatedNode: ReactEvaluatedNode
  ): Value {
    invariant(this.realm.generator);
    // TODO investigate what other kinds than "conditional" might be safe to deeply resolve
    if (value.kind === "conditional") {
      let [condValue, consequentVal, alternateVal] = value.args;
      invariant(condValue instanceof AbstractValue);
      return this._resolveAbstractConditionalValue(
        componentType,
        condValue,
        consequentVal,
        alternateVal,
        context,
        evaluatedNode
      );
    } else {
      if (value instanceof AbstractValue && this.realm.react.abstractHints.has(value)) {
        let reactHint = this.realm.react.abstractHints.get(value);

        invariant(reactHint !== undefined);
        if (reactHint.object === this.realm.fbLibraries.reactDom && reactHint.propertyName === "createPortal") {
          return this._resolveReactDomPortal(
            value,
            reactHint.args,
            componentType,
            context,
            branchStatus,
            evaluatedNode
          );
        }
      }
      this.componentTreeState.deadEnds++;
    }
    return value;
  }

  _resolveUnknownComponentType(reactElement: ObjectValue, evaluatedNode: ReactEvaluatedNode) {
    let typeValue = getProperty(this.realm, reactElement, "type");
    let propsValue = getProperty(this.realm, reactElement, "props");

    this._findReactComponentTrees(propsValue, evaluatedNode, "NORMAL_FUNCTIONS");
    if (typeValue instanceof AbstractValue) {
      this._findReactComponentTrees(typeValue, evaluatedNode, "FUNCTIONAL_COMPONENTS");
      return reactElement;
    } else {
      let evaluatedChildNode = createReactEvaluatedNode("BAIL-OUT", getComponentName(this.realm, typeValue));
      evaluatedNode.children.push(evaluatedChildNode);
      let bailOutMessage = `type on <Component /> was not a ECMAScriptSourceFunctionValue`;
      evaluatedChildNode.message = bailOutMessage;
      this._assignBailOutMessage(reactElement, bailOutMessage);
      this.componentTreeState.deadEnds++;
      return reactElement;
    }
  }

  _resolveReactElementBadRef(reactElement: ObjectValue, evaluatedNode: ReactEvaluatedNode) {
    let typeValue = getProperty(this.realm, reactElement, "type");
    let propsValue = getProperty(this.realm, reactElement, "props");

    let evaluatedChildNode = createReactEvaluatedNode("BAIL-OUT", getComponentName(this.realm, typeValue));
    evaluatedNode.children.push(evaluatedChildNode);
    let bailOutMessage = `refs are not supported on <Components />`;
    evaluatedChildNode.message = bailOutMessage;

    this._queueNewComponentTree(typeValue, evaluatedChildNode);
    this._findReactComponentTrees(propsValue, evaluatedNode, "NORMAL_FUNCTIONS");
    this._assignBailOutMessage(reactElement, bailOutMessage);
    return reactElement;
  }

  _resolveReactElementUndefinedRender(
    reactElement: ObjectValue,
    evaluatedNode: ReactEvaluatedNode,
    branchStatus: BranchStatusEnum
  ) {
    let typeValue = getProperty(this.realm, reactElement, "type");
    let propsValue = getProperty(this.realm, reactElement, "props");

    let evaluatedChildNode = createReactEvaluatedNode("BAIL-OUT", getComponentName(this.realm, typeValue));
    evaluatedNode.children.push(evaluatedChildNode);
    let bailOutMessage = `undefined was returned from render`;
    evaluatedChildNode.message = bailOutMessage;

    this._assignBailOutMessage(reactElement, bailOutMessage);
    this._findReactComponentTrees(propsValue, evaluatedNode, "NORMAL_FUNCTIONS");
    return reactElement;
  }

  _resolveReactElementHostChildren(
    componentType: Value,
    reactElement: ObjectValue,
    context: ObjectValue | AbstractObjectValue,
    branchStatus: BranchStatusEnum,
    evaluatedNode: ReactEvaluatedNode
  ) {
    let typeValue = getProperty(this.realm, reactElement, "type");
    let propsValue = getProperty(this.realm, reactElement, "props");
    let keyValue = getProperty(this.realm, reactElement, "key");
    let refValue = getProperty(this.realm, reactElement, "ref");
    // terminal host component. Start evaluating its children.
    if (propsValue instanceof ObjectValue && propsValue.properties.has("children")) {
      let childrenValue = Get(this.realm, propsValue, "children");

      if (childrenValue instanceof Value) {
        let resolvedChildren = this._resolveDeeply(componentType, childrenValue, context, branchStatus, evaluatedNode);
        // we can optimize further and flatten arrays on non-composite components
        if (resolvedChildren instanceof ArrayValue && !resolvedChildren.intrinsicName) {
          resolvedChildren = flattenChildren(this.realm, resolvedChildren);
        }
        if (resolvedChildren !== childrenValue) {
          let newProps = new ObjectValue(this.realm, this.realm.intrinsics.ObjectPrototype);

          for (let [key, binding] of propsValue.properties) {
            if (binding && binding.descriptor && binding.descriptor.enumerable && key !== "children") {
              Properties.Set(this.realm, newProps, key, getProperty(this.realm, propsValue, key), true);
            }
          }
          Properties.Set(this.realm, newProps, "children", resolvedChildren, true);
          if (propsValue.isSimpleObject()) {
            newProps.makeSimple();
          }
          if (propsValue.isPartialObject()) {
            newProps.makePartial();
          }
          if (this.realm.react.propsWithNoPartialKeyOrRef.has(propsValue)) {
            flagPropsWithNoPartialKeyOrRef(this.realm, newProps);
          }
          newProps.makeFinal();
          return createInternalReactElement(this.realm, typeValue, keyValue, refValue, newProps);
        }
      }
    }
    return reactElement;
  }

  _resolveFragmentComponent(
    componentType: Value,
    reactElement: ObjectValue,
    context: ObjectValue | AbstractObjectValue,
    branchStatus: BranchStatusEnum,
    evaluatedNode: ReactEvaluatedNode
  ) {
    this.statistics.componentsEvaluated++;
    if (this.componentTreeConfig.firstRenderOnly) {
      let evaluatedChildNode = createReactEvaluatedNode("INLINED", "React.Fragment");
      evaluatedNode.children.push(evaluatedChildNode);
      this.statistics.inlinedComponents++;
      let children = this._resolveReactElementHostChildren(
        componentType,
        reactElement,
        context,
        branchStatus,
        evaluatedChildNode
      );
      return children;
    } else {
      let evaluatedChildNode = createReactEvaluatedNode("NORMAL", "React.Fragment");
      evaluatedNode.children.push(evaluatedChildNode);
      return this._resolveReactElementHostChildren(
        componentType,
        reactElement,
        context,
        branchStatus,
        evaluatedChildNode
      );
    }
  }

  _resolveReactElement(
    componentType: Value,
    reactElement: ObjectValue,
    context: ObjectValue | AbstractObjectValue,
    branchStatus: BranchStatusEnum,
    evaluatedNode: ReactEvaluatedNode
  ) {
    reactElement = this.componentTreeConfig.firstRenderOnly
      ? sanitizeReactElementForFirstRenderOnly(this.realm, reactElement)
      : reactElement;

    let typeValue = getProperty(this.realm, reactElement, "type");
    let propsValue = getProperty(this.realm, reactElement, "props");
    let refValue = getProperty(this.realm, reactElement, "ref");

    invariant(
      !(typeValue instanceof AbstractValue && typeValue.kind === "conditional"),
      `the reconciler should never encounter a ReactElement "type" that is conditional abstract value`
    );
    invariant(
      !(propsValue instanceof AbstractValue && propsValue.kind === "conditional"),
      `the reconciler should never encounter a ReactElement "props" that is conditional abstract value`
    );

    if (typeValue instanceof StringValue) {
      return this._resolveReactElementHostChildren(componentType, reactElement, context, branchStatus, evaluatedNode);
    }
    if (!(propsValue instanceof ObjectValue || propsValue instanceof AbstractObjectValue)) {
      this._assignBailOutMessage(
        reactElement,
        `props on <Component /> was not not an ObjectValue or an AbstractObjectValue`
      );
      return reactElement;
    }
    let componentResolutionStrategy = this._getComponentResolutionStrategy(typeValue);

    // We do not support "ref" on <Component /> ReactElements, unless it's a forwarded ref
    if (
      !(refValue instanceof NullValue) &&
      componentResolutionStrategy !== "FORWARD_REF" &&
      // If we have an abstract value, it might mean a bad ref, but we will have
      // already thrown a FatalError in the createElement implementation by this
      // point, so if we're here, then the FatalError has been recovered explicitly
      !(refValue instanceof AbstractValue)
    ) {
      this._resolveReactElementBadRef(reactElement, evaluatedNode);
    }
    try {
      let result;

      switch (componentResolutionStrategy) {
        case "NORMAL": {
          if (
            !(typeValue instanceof ECMAScriptSourceFunctionValue || valueIsKnownReactAbstraction(this.realm, typeValue))
          ) {
            return this._resolveUnknownComponentType(reactElement, evaluatedNode);
          }
          let evaluatedChildNode = createReactEvaluatedNode("INLINED", getComponentName(this.realm, typeValue));
          let render = this._resolveComponent(
            typeValue,
            propsValue,
            context,
            branchStatus === "NEW_BRANCH" ? "BRANCH" : branchStatus,
            evaluatedChildNode
          );
          if (this.logger !== undefined && this.realm.react.verbose && evaluatedChildNode.status === "INLINED") {
            this.logger.logInformation(`    ✔ ${evaluatedChildNode.name} (inlined)`);
          }
          evaluatedNode.children.push(evaluatedChildNode);
          result = render.result;
          this.statistics.inlinedComponents++;
          break;
        }
        case "FRAGMENT": {
          return this._resolveFragmentComponent(componentType, reactElement, context, branchStatus, evaluatedNode);
        }
        case "RELAY_QUERY_RENDERER": {
          invariant(typeValue instanceof AbstractObjectValue);
          result = this._resolveRelayQueryRendererComponent(componentType, reactElement, context, evaluatedNode);
          break;
        }
        case "CONTEXT_PROVIDER": {
          return this._resolveContextProviderComponent(
            componentType,
            reactElement,
            context,
            branchStatus,
            evaluatedNode
          );
        }
        case "CONTEXT_CONSUMER": {
          result = this._resolveContextConsumerComponent(componentType, reactElement, context, evaluatedNode);
          break;
        }
        case "FORWARD_REF": {
          result = this._resolveForwardRefComponent(componentType, reactElement, context, branchStatus, evaluatedNode);
          break;
        }
        default:
          invariant(false, "unsupported component resolution strategy");
      }

      if (result === undefined) {
        result = reactElement;
      }
      if (result instanceof UndefinedValue) {
        return this._resolveReactElementUndefinedRender(reactElement, evaluatedNode, branchStatus);
      }
      return result;
    } catch (error) {
      return this._resolveComponentResolutionFailure(error, reactElement, evaluatedNode, branchStatus);
    }
  }

  _handleComponentTreeRootFailure(error: Error | Completion, evaluatedRootNode: ReactEvaluatedNode): void {
    if (error.name === "Invariant Violation") {
      throw error;
    } else if (error instanceof ReconcilerFatalError) {
      throw new ReconcilerFatalError(error.message, evaluatedRootNode);
    } else if (error instanceof UnsupportedSideEffect || error instanceof DoNotOptimize) {
      throw new ReconcilerFatalError(
        `Failed to render React component root "${evaluatedRootNode.name}" due to ${error.message}`,
        evaluatedRootNode
      );
    } else if (error instanceof Completion) {
      let value = error.value;
      invariant(value instanceof ObjectValue);
      let message = getProperty(this.realm, value, "message");
      let stack = getProperty(this.realm, value, "stack");
      invariant(message instanceof StringValue);
      invariant(stack instanceof StringValue);
      throw new ReconcilerFatalError(
        `Failed to render React component "${evaluatedRootNode.name}" due to a JS error: ${message.value}\n${
          stack.value
        }`,
        evaluatedRootNode
      );
    }
    let message;
    if (error instanceof ExpectedBailOut) {
      message = `Failed to optimize React component tree for "${evaluatedRootNode.name}" due to an expected bail-out: ${
        error.message
      }`;
    } else if (error instanceof FatalError) {
      message = `Failed to optimize React component tree for "${
        evaluatedRootNode.name
      }" due to a fatal error during evaluation: ${error.message}`;
    } else {
      // if we don't know what the error is, then best to rethrow
      throw error;
    }
    throw new ReconcilerFatalError(message, evaluatedRootNode);
  }

  _resolveComponentResolutionFailure(
    error: Error | Completion,
    reactElement: ObjectValue,
    evaluatedNode: ReactEvaluatedNode,
    branchStatus: BranchStatusEnum
  ): Value {
    if (error.name === "Invariant Violation") {
      throw error;
    } else if (error instanceof ReconcilerFatalError) {
      throw error;
    } else if (error instanceof UnsupportedSideEffect) {
      throw new ReconcilerFatalError(
        `Failed to render React component "${evaluatedNode.name}" due to ${error.message}`,
        evaluatedNode
      );
    } else if (error instanceof DoNotOptimize) {
      return reactElement;
    } else if (error instanceof Completion) {
      let value = error.value;
      invariant(value instanceof ObjectValue);
      let message = getProperty(this.realm, value, "message");
      let stack = getProperty(this.realm, value, "stack");
      invariant(message instanceof StringValue);
      invariant(stack instanceof StringValue);
      throw new ReconcilerFatalError(
        `Failed to render React component "${evaluatedNode.name}" due to a JS error: ${message.value}\n${stack.value}`,
        evaluatedNode
      );
    }
    let typeValue = getProperty(this.realm, reactElement, "type");
    let propsValue = getProperty(this.realm, reactElement, "props");
    // assign a bail out message
    if (error instanceof NewComponentTreeBranch) {
      this._findReactComponentTrees(propsValue, evaluatedNode, "NORMAL_FUNCTIONS");
      evaluatedNode.children.push(error.evaluatedNode);
      // NO-OP (we don't queue a newComponentTree as this was already done)
    } else {
      let evaluatedChildNode = createReactEvaluatedNode("BAIL-OUT", getComponentName(this.realm, typeValue));
      if (this.logger !== undefined && this.realm.react.verbose) {
        this.logger.logInformation(`    ✖ ${evaluatedChildNode.name} (bail-out)`);
      }
      evaluatedNode.children.push(evaluatedChildNode);
      this._queueNewComponentTree(typeValue, evaluatedChildNode);
      this._findReactComponentTrees(propsValue, evaluatedNode, "NORMAL_FUNCTIONS");
      if (error instanceof ExpectedBailOut) {
        evaluatedChildNode.message = error.message;
        this._assignBailOutMessage(reactElement, error.message);
      } else if (error instanceof FatalError) {
        let message = "evaluation failed";
        evaluatedChildNode.message = message;
        this._assignBailOutMessage(reactElement, message);
      } else {
        evaluatedChildNode.message = `unknown error`;
        throw error;
      }
    }
    // a child component bailed out during component folding, so return the function value and continue
    return reactElement;
  }

  _resolveDeeply(
    componentType: Value,
    value: Value,
    context: ObjectValue | AbstractObjectValue,
    branchStatus: BranchStatusEnum,
    evaluatedNode: ReactEvaluatedNode
  ): Value {
    if (
      value instanceof StringValue ||
      value instanceof NumberValue ||
      value instanceof BooleanValue ||
      value instanceof NullValue ||
      value instanceof UndefinedValue
    ) {
      // terminal values
      return value;
    }
    invariant(
      !(value instanceof ObjectValue) || value._isFinal !== undefined,
      `An object value was detected during React reconcilation without its bindings properly applied`
    );
    if (value instanceof AbstractValue) {
      return this._resolveAbstractValue(componentType, value, context, branchStatus, evaluatedNode);
    }
    // TODO investigate what about other iterables type objects
    if (value instanceof ArrayValue) {
      return this._resolveArray(componentType, value, context, branchStatus, evaluatedNode);
    }
    if (value instanceof ObjectValue && isReactElement(value)) {
      return this._resolveReactElement(componentType, value, context, branchStatus, evaluatedNode);
    } else {
      let location = getLocationFromValue(value.expressionLocation);
      throw new ExpectedBailOut(`invalid return value from render${location}`);
    }
  }

  _assignBailOutMessage(reactElement: ObjectValue, message: string): void {
    // $BailOutReason is a field on ObjectValue that allows us to specify a message
    // that gets serialized as a comment node during the ReactElement serialization stage
    message = `Bail-out: ${message}`;
    if (reactElement.$BailOutReason !== undefined) {
      // merge bail out messages if one already exists
      reactElement.$BailOutReason += `, ${message}`;
    } else {
      reactElement.$BailOutReason = message;
    }
  }

  _resolveArray(
    componentType: Value,
    arrayValue: ArrayValue,
    context: ObjectValue | AbstractObjectValue,
    branchStatus: BranchStatusEnum,
    evaluatedNode: ReactEvaluatedNode
  ): ArrayValue {
    if (ArrayValue.isIntrinsicAndHasWidenedNumericProperty(arrayValue)) {
      let arrayHint = this.realm.react.arrayHints.get(arrayValue);

      if (arrayHint !== undefined) {
        let { func, thisVal } = arrayHint;
        if (func instanceof ECMAScriptSourceFunctionValue || func instanceof BoundFunctionValue) {
          if (thisVal && thisVal !== this.realm.intrinsics.undefined) {
            throw new ExpectedBailOut(`abstract mapped arrays with "this" argument are not yet supported`);
          }
          this._queueOptimizedClosure(func, evaluatedNode, componentType, context);
        }
        return arrayValue;
      }
    }
    return mapArrayValue(this.realm, arrayValue, elementValue =>
      this._resolveDeeply(componentType, elementValue, context, "NEW_BRANCH", evaluatedNode)
    );
  }

  hasEvaluatedRootNode(componentType: ECMAScriptSourceFunctionValue, evaluateNode: ReactEvaluatedNode): boolean {
    if (this.alreadyEvaluatedRootNodes.has(componentType)) {
      let alreadyEvaluatedNode = this.alreadyEvaluatedRootNodes.get(componentType);
      invariant(alreadyEvaluatedNode);
      evaluateNode.children = alreadyEvaluatedNode.children;
      evaluateNode.status = alreadyEvaluatedNode.status;
      evaluateNode.name = alreadyEvaluatedNode.name;
      return true;
    }
    return false;
  }

  hasEvaluatedNestedClosure(func: ECMAScriptSourceFunctionValue | BoundFunctionValue): boolean {
    return this.alreadyEvaluatedNestedClosures.has(func);
  }

  _findReactComponentTrees(
    value: Value,
    evaluatedNode: ReactEvaluatedNode,
    treatFunctionsAs: "NORMAL_FUNCTIONS" | "NESTED_CLOSURES" | "FUNCTIONAL_COMPONENTS",
    componentType?: Value,
    context?: ObjectValue | AbstractObjectValue
  ): void {
    if (value instanceof AbstractValue) {
      if (value.args.length > 0) {
        for (let arg of value.args) {
          this._findReactComponentTrees(arg, evaluatedNode, treatFunctionsAs, componentType, context);
        }
      } else {
        this.componentTreeState.deadEnds++;
      }
    } else if (valueIsKnownReactAbstraction(this.realm, value)) {
      let evaluatedChildNode = createReactEvaluatedNode("NEW_TREE", getComponentName(this.realm, value));
      evaluatedNode.children.push(evaluatedChildNode);
      this._queueNewComponentTree(value, evaluatedChildNode);
    } else if (value instanceof ECMAScriptSourceFunctionValue || value instanceof BoundFunctionValue) {
      if (valueIsClassComponent(this.realm, value) || treatFunctionsAs === "FUNCTIONAL_COMPONENTS") {
        let evaluatedChildNode = createReactEvaluatedNode("NEW_TREE", getComponentName(this.realm, value));
        evaluatedNode.children.push(evaluatedChildNode);
        this._queueNewComponentTree(value, evaluatedChildNode);
      } else if (treatFunctionsAs === "NESTED_CLOSURES") {
        invariant(componentType && context);
        this._queueOptimizedClosure(value, evaluatedNode, componentType, context);
      }
    } else if (value instanceof ObjectValue) {
      if (isReactElement(value)) {
        let typeValue = getProperty(this.realm, value, "type");
        let ref = getProperty(this.realm, value, "ref");
        let props = getProperty(this.realm, value, "props");

        if (valueIsKnownReactAbstraction(this.realm, typeValue) || typeValue instanceof ECMAScriptSourceFunctionValue) {
          let evaluatedChildNode = createReactEvaluatedNode("NEW_TREE", getComponentName(this.realm, typeValue));
          evaluatedNode.children.push(evaluatedChildNode);
          this._queueNewComponentTree(typeValue, evaluatedChildNode);
        }
        this._findReactComponentTrees(ref, evaluatedNode, treatFunctionsAs, componentType, context);
        this._findReactComponentTrees(props, evaluatedNode, treatFunctionsAs, componentType, context);
      } else {
        for (let [propName, binding] of value.properties) {
          if (binding && binding.descriptor && binding.descriptor.enumerable) {
            this._findReactComponentTrees(
              getProperty(this.realm, value, propName),
              evaluatedNode,
              treatFunctionsAs,
              componentType,
              context
            );
          }
        }
      }
    }
  }

  _handleReportedSideEffect(
    sideEffectType: SideEffectType,
    binding: void | Binding | PropertyBinding,
    expressionLocation: any
  ): void {
    let location = getLocationFromValue(expressionLocation);

    if (sideEffectType === "MODIFIED_BINDING") {
      let name = binding ? `"${((binding: any): Binding).name}"` : "unknown";
      throw new UnsupportedSideEffect(`side-effects from mutating the binding ${name}${location}`);
    } else if (sideEffectType === "MODIFIED_PROPERTY" || sideEffectType === "MODIFIED_GLOBAL") {
      let name = "";
      let key = ((binding: any): PropertyBinding).key;
      if (typeof key === "string") {
        name = `"${key}"`;
      }
      if (sideEffectType === "MODIFIED_PROPERTY") {
        throw new UnsupportedSideEffect(`side-effects from mutating a property ${name}${location}`);
      } else {
        throw new UnsupportedSideEffect(`side-effects from mutating the global object property ${name}${location}`);
      }
    } else if (sideEffectType === "EXCEPTION_THROWN") {
      throw new UnsupportedSideEffect(`side-effects from throwing exception${location}`);
    }
  }
}
