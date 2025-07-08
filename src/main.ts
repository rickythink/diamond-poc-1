import './style.css'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import Stats from 'three/addons/libs/stats.module.js'
// 1. 取消注释或添加 RGBELoader 导入
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import {
  MeshBVH,
  MeshBVHUniformStruct,
  shaderStructs,
  shaderIntersectFunction,
  SAH
} from 'three-mesh-bvh';


// 场景 (Scene)
const scene = new THREE.Scene()
scene.background = new THREE.Color(0xefefef); 

// 相机 (Camera)
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100)
camera.position.set(2.0, 3.0, 2.0);

// 渲染器 (Renderer)
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: true,
 });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2.0))
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.outputColorSpace  = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

// 2. 为渲染器添加色调映射 (Tone Mapping)，以更好地处理 HDR 效果
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0; // 可以根据需要调整曝光度

document.body.appendChild( renderer.domElement );


// 轨道控制器 (OrbitControls)
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.2;
controls.enableRotate = true;
controls.target.set(0.0, 0.0, 0.0);
controls.enabled = true;

// 状态显示 (Stats)
const stats = new Stats()
document.body.appendChild(stats.dom)

// 辅助线 (Helper)
const GridHelper = new THREE.GridHelper( 5, 5, 0xcccccc, 0xcccccc )
scene.add(GridHelper)


// 材质 (Material)
const diamondMaterial = new THREE.ShaderMaterial({
  uniforms: {
    // 3. 初始化 envMap 为 null，稍后在 HDR 加载完成后再赋值
    envMap: { value: null },
    bvh: { value: new MeshBVHUniformStruct() },
    projectionMatrixInv: { value: camera.projectionMatrixInverse },
    viewMatrixInv: { value: camera.matrixWorld },
    resolution: { value:new THREE.Vector2(window.innerWidth, window.innerHeight)  },
    bounces: { value: 3 },
    ior: { value: 2.4 },
    color: { value: new THREE.Color( 0xFFFFFF ) },
    fastChroma: { value: false },
    aberrationStrength: { value: 0.01 },
},
vertexShader:`
      varying vec3 vWorldPosition;
      varying vec3 vNormal;
      uniform mat4 viewMatrixInv;
      void main() {

        vWorldPosition = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
        vNormal = ( viewMatrixInv * vec4( normalMatrix * normal, 0.0 ) ).xyz;
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4( position , 1.0 );

      }
`,
fragmentShader: `
      #define RAY_OFFSET 0.001

      #include <common>
      precision highp isampler2D;
      precision highp usampler2D;

      ${ shaderStructs }
      ${ shaderIntersectFunction }

      varying vec3 vWorldPosition;
      varying vec3 vNormal;

      uniform sampler2D envMap;
      uniform float bounces;
      uniform BVH bvh;
      uniform float ior;
      uniform vec3 color;
      uniform bool fastChroma;
      uniform mat4 projectionMatrixInv;
      uniform mat4 viewMatrixInv;
      uniform mat4 modelMatrix;
      uniform vec2 resolution;
      uniform float aberrationStrength;

      #include <cube_uv_reflection_fragment>

      vec3 totalInternalReflection( vec3 incomingOrigin, vec3 incomingDirection, vec3 normal, float ior, mat4 modelMatrixInverse ) {

        vec3 rayOrigin = incomingOrigin;
        vec3 rayDirection = incomingDirection;

        rayDirection = refract( rayDirection, normal, 1.0 / ior );
        rayOrigin = vWorldPosition + rayDirection * RAY_OFFSET;

        rayOrigin = ( modelMatrixInverse * vec4( rayOrigin, 1.0 ) ).xyz;
        rayDirection = normalize( ( modelMatrixInverse * vec4( rayDirection, 0.0 ) ).xyz );

        for( float i = 0.0; i < bounces; i ++ ) {

          uvec4 faceIndices = uvec4( 0u );
          vec3 faceNormal = vec3( 0.0, 0.0, 1.0 );
          vec3 barycoord = vec3( 0.0 );
          float side = 1.0;
          float dist = 0.0;

          bvhIntersectFirstHit( bvh, rayOrigin, rayDirection, faceIndices, faceNormal, barycoord, side, dist );

          vec3 hitPos = rayOrigin + rayDirection * dist;

          vec3 refractedDirection = refract( rayDirection, faceNormal, ior );
          bool totalInternalReflection = length( refract( rayDirection, faceNormal, ior ) ) == 0.0;
          if ( ! totalInternalReflection ) {

            rayDirection = refractedDirection;
            break;

          }

          rayDirection = reflect( rayDirection, faceNormal );
          rayOrigin = hitPos + rayDirection * RAY_OFFSET;

        }

        return normalize( ( modelMatrix * vec4( rayDirection, 0.0 ) ).xyz );
      }

      vec4 envSample( sampler2D envMap, vec3 rayDirection ) {

        vec2 uvv = equirectUv( rayDirection );
        return texture( envMap, uvv );

      }

      void main() {

        mat4 modelMatrixInverse = inverse( modelMatrix );
        vec2 uv = gl_FragCoord.xy / resolution;

        vec3 normal = vNormal;
        vec3 rayOrigin = cameraPosition;
        vec3 rayDirection = normalize( vWorldPosition - cameraPosition );

        if ( aberrationStrength != 0.0 ) {

          vec3 rayDirectionG = totalInternalReflection( rayOrigin, rayDirection, normal, max( ior, 1.0 ), modelMatrixInverse );
          vec3 rayDirectionR, rayDirectionB;

          if ( fastChroma ) {

            rayDirectionR = normalize( rayDirectionG + 1.0 * vec3( aberrationStrength / 2.0 ) );
            rayDirectionB = normalize( rayDirectionG - 1.0 * vec3( aberrationStrength / 2.0 ) );

          } else {

            float iorR = max( ior * ( 1.0 - aberrationStrength ), 1.0 );
            float iorB = max( ior * ( 1.0 + aberrationStrength ), 1.0 );
            rayDirectionR = totalInternalReflection(
              rayOrigin, rayDirection, normal,
              iorR, modelMatrixInverse
            );
            rayDirectionB = totalInternalReflection(
              rayOrigin, rayDirection, normal,
              iorB, modelMatrixInverse
            );

          }

          float r = envSample( envMap, rayDirectionR ).r;
          float g = envSample( envMap, rayDirectionG ).g;
          float b = envSample( envMap, rayDirectionB ).b;
          gl_FragColor.rgb = vec3( r, g, b ) * color;
          gl_FragColor.a = 1.0;

        } else {

          rayDirection = totalInternalReflection( rayOrigin, rayDirection, normal, max( ior, 1.0 ), modelMatrixInverse );
          gl_FragColor.rgb = envSample( envMap, rayDirection ).rgb * color;
          gl_FragColor.a = 1.0;

        }

        #include <tonemapping_fragment>

      }
  `,
})


// 4. 调整资源加载逻辑
const rgbeLoader = new RGBELoader();
const dracoLoader = new DRACOLoader();
const loader = new GLTFLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');
loader.setDRACOLoader(dracoLoader);

let diamond;

// 首先加载 HDR 环境贴图
rgbeLoader.load(
    './hdr/001.hdr', // 你的 HDR 文件路径
    (environmentMap) => {
        // HDR 加载成功后的回调
        environmentMap.mapping = THREE.EquirectangularReflectionMapping;

        scene.environment = environmentMap;

        // 将加载的贴图更新到钻石材质的 uniform 中
        diamondMaterial.uniforms.envMap.value = environmentMap;

        // 环境贴图加载完毕后，再开始加载 GLB 模型
        loader.load('./model/daimondo.glb',
            function (loadedObject) {
                const diamondGeo = loadedObject.scene.children[0].geometry;

                const bvh = new MeshBVH(diamondGeo, { strategy: SAH, maxLeafTris: 1 });
                diamondMaterial.uniforms.bvh.value.updateFrom(bvh);
                diamond = new THREE.Mesh(diamondGeo, diamondMaterial);

                scene.add(diamond);
            },
            function (xhr) {
                console.log('Model: ' + (xhr.loaded / xhr.total * 100) + '% loaded');
            },
            function (error) {
                console.error('An error happened with the model', error);
            }
        );
    },
    (xhr) => {
        console.log('HDR: ' + (xhr.loaded / xhr.total * 100) + '% loaded');
    },
    (error) => {
        console.error('An error happened loading the HDR', error);
    }
);


function RenderLoop() {
  controls.update()
  renderer.render(scene, camera)
  stats.update()
  requestAnimationFrame(RenderLoop)
}

RenderLoop()


window.addEventListener('resize', () => {
  const pixel = Math.min(window.devicePixelRatio, 2.0);
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setPixelRatio(pixel)
  renderer.setSize(window.innerWidth, window.innerHeight);
  diamondMaterial.uniforms.resolution.value = new THREE.Vector2(window.innerWidth, window.innerHeight);
})