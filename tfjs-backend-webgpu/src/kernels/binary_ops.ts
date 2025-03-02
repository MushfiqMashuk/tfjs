/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

import {util} from '@tensorflow/tfjs-core';
import {BinaryOpSharedProgram} from './binary_op_shared_webgpu';
import {BinaryOpVec4Program} from './binary_op_vec4_webgpu';
import {BinaryOpProgram} from './binary_op_webgpu';

export enum BinaryOpType {
  MUL,
  ADD,
  SUB,
  DIV,
  EQUAL,
  GREATER,
  GREATER_EQUAL,
  LESS,
  LESS_EQUAL,
  LOGICAL_AND,
  NOT_EQUAL,
  SQUARED_DIFFERENCE,
  INT_DIV,
  POW,
  PRELU,
  MAX,
  MIN
}

const CHECK_NAN_SNIPPET = `
if (isnan(a)) return a;
if (isnan(b)) return b;
`;
const CHECK_NAN_SNIPPET_VEC4 = `
result.r = isNaN.r > 0. ? NAN : result.r;
result.g = isNaN.g > 0. ? NAN : result.g;
result.b = isNaN.b > 0. ? NAN : result.b;
result.a = isNaN.a > 0. ? NAN : result.a;
`;

function getMinMaxString(op: string, useVec4: boolean) {
  const checkNanSnippet = useVec4 ? CHECK_NAN_SNIPPET_VEC4 : CHECK_NAN_SNIPPET;
  return useVec4 ? `
  vec4 result = vec4(${op}(a, b));
  vec4 isNaN = min(vec4(isnan(a)) + vec4(isnan(b)), vec4(1.0));
  ` + checkNanSnippet +
          `
  return result;
` :
                   checkNanSnippet + `
  return ${op}(a, b);
`;
}

export function getBinaryOpString(
    type: BinaryOpType, useVec4?: boolean): string {
  switch (type) {
    case BinaryOpType.MUL:
      return 'return a * b;';
    case BinaryOpType.ADD:
      return 'return a + b;';
    case BinaryOpType.SUB:
      return 'return a - b;';
    case BinaryOpType.DIV:
      return 'return a / b;';
    case BinaryOpType.EQUAL:
      return useVec4 ? 'return vec4(equal(a, b));' : 'return float(a == b);';
    case BinaryOpType.GREATER:
      return useVec4 ? 'return vec4(greaterThan(a, b));' :
                       'return float(a > b);';
    case BinaryOpType.GREATER_EQUAL:
      return useVec4 ? 'return vec4(greaterThanEqual(a, b));' :
                       'return float(a >= b);';
    case BinaryOpType.LESS:
      return useVec4 ? 'return vec4(lessThan(a, b));' : 'return float(a < b);';
    case BinaryOpType.LESS_EQUAL:
      return useVec4 ? 'return vec4(lessThanEqual(a, b));' :
                       'return float(a <= b);';
    case BinaryOpType.LOGICAL_AND:
      return useVec4 ? `return vec4(
      vec4(greaterThanEqual(a, vec4(1.0))) *
      vec4(greaterThanEqual(b, vec4(1.0))));` :
                       'return float(float(a) >= 1.0 && float(b) >= 1.0);';
    case BinaryOpType.NOT_EQUAL:
      return useVec4 ? 'return vec4(notEqual(a, b));' : 'return float(a != b);';
    case BinaryOpType.SQUARED_DIFFERENCE:
      return 'return (a - b) * (a - b);';
    case BinaryOpType.INT_DIV:
      return useVec4 ? `
      ivec4 ia = round(a);
      ivec4 ib = round(b);
      bvec4 cond = notEqual(ib, ivec4(0));
      ivec4 result = ivec4(0);
      vec4 s = sign(a) * sign(b);

      // Windows (D3D) wants guaranteed non-zero int division at compile-time.
      if (cond[0]) {
        result[0] = idiv(ia[0], ib[0], s[0]);
      }
      if (cond[1]) {
        result[1] = idiv(ia[1], ib[1], s[1]);
      }
      if (cond[2]) {
        result[2] = idiv(ia[2], ib[2], s[2]);
      }
      if (cond[3]) {
        result[3] = idiv(ia[3], ib[3], s[3]);
      }
      return vec4(result);
    ` :
                       `
    float s = sign(a) * sign(b);
    int ia = int(round(a));
    int ib = int(round(b));
    return float(idiv(ia, ib, s));
  `;
    case BinaryOpType.PRELU:
      return useVec4 ? `
      vec4 aLessThanZero = vec4(lessThan(a, vec4(0.)));
      return (aLessThanZero * (b * a)) + ((vec4(1.0) - aLessThanZero) * a);
    ` :
                       'return (a < 0.) ? b * a : a;';
    case BinaryOpType.MAX:
      return getMinMaxString('max', useVec4);
    case BinaryOpType.MIN:
      return getMinMaxString('min', useVec4);
    case BinaryOpType.POW:
      return useVec4 ? `
      // isModRound1 has 1 for components with round(mod(b, 2.0)) == 1, 0 otherwise.
      vec4 isModRound1 = vec4(equal(round(mod(b, 2.0)), ivec4(1)));
      vec4 multiplier = sign(a) * isModRound1 + (vec4(1.0) - isModRound1);
      vec4 result = multiplier * pow(abs(a), b);

      // Ensure that a^0 = 1, including 0^0 = 1 as this correspond to TF and JS
      bvec4 isExpZero = equal(b, vec4(0.0));
      result.r = isExpZero.r ? 1.0 : result.r;
      result.g = isExpZero.g ? 1.0 : result.g;
      result.b = isExpZero.b ? 1.0 : result.b;
      result.a = isExpZero.a ? 1.0 : result.a;

      vec4 isNaN = vec4(lessThan(a, vec4(0.0))) * vec4(lessThan(floor(b), b));
      ${CHECK_NAN_SNIPPET_VEC4}
      return result;
    ` :
                       `
    if(a < 0.0 && floor(b) < b){
      return NAN;
    }
    if (b == 0.0) {
      return 1.0;
    }
    return (round(mod(b, 2.0)) != 1) ?
        pow(abs(a), b) : sign(a) * pow(abs(a), b);
  `;
    default:
      throw new Error(`BinaryType ${type} is not implemented!`);
  }
}

export function getBinaryProgram(
    op: BinaryOpType, aShape: number[], bShape: number[]) {
  const useVec4 =
      util.arraysEqual(aShape, bShape) && util.sizeFromShape(aShape) % 4 === 0;
  const opStr = getBinaryOpString(op, useVec4);
  if (useVec4) {
    return new BinaryOpVec4Program(opStr, aShape, bShape);
  }
  const useSharedMemoryWithA =
      aShape.length === 1 && bShape.length > 1 && aShape[0] < 2048;
  const useSharedMemoryWithB =
      bShape.length === 1 && aShape.length > 1 && bShape[0] < 2048;
  if (useSharedMemoryWithA || useSharedMemoryWithB) {
    return new BinaryOpSharedProgram(
        opStr, aShape, bShape, useSharedMemoryWithB);
  } else {
    return new BinaryOpProgram(opStr, aShape, bShape);
  }
}
