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
    envMap: { value: null },
    bvh: { value: new MeshBVHUniformStruct() },
    projectionMatrixInv: { value: camera.projectionMatrixInverse },
    viewMatrixInv: { value: camera.matrixWorld },
    resolution: { value:new THREE.Vector2(window.innerWidth, window.innerHeight)  },
    bounces: { value: 3 }, // 内部反弹次数
    ior: { value: 2.418 }, // 钻石的折射率 (IOR)
    color: { value: new THREE.Color( 0xFFFFFF ) },
    fresnelFactor: { value: 0.6 }, // 菲涅尔效应强度，可按需调整
		
		// --- 1. 基于柯西方程的色散控制 ---
    // 钻石的柯西方程系数 A 和 B (B的单位是 nm²)
    // A: 基础折射率, B: 色散强度系数
    cauchyA: { value: 2.388 }, // for diamond: ~2.38 to 2.40
    cauchyB: { value: 16000 }, // for diamond: ~12000 to 19000 nm²
    
    // --- 2. 基于比尔-朗伯定律的吸收控制 ---
    // 吸收系数，代表每单位距离光被吸收的比例
    // 对于纯白钻石，设置一个非常低的灰色值
    // 对于彩色钻石，可以设置特定颜色，如淡黄色 (1.0, 1.0, 0.8)
    absorptionColor: { value: new THREE.Vector3(0.0, 0.0, 0.0) },
},
vertexShader:`
      varying vec3 vWorldPosition;
      varying vec3 vNormal;
      uniform mat4 viewMatrixInv;
      void main() {
        // 将法线转换为世界坐标，而不是视图坐标
        vWorldPosition = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
        vNormal = normalize( mat3( modelMatrix ) * normal );
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4( position, 1.0 );
      }
`,
fragmentShader: `
      #define RAY_OFFSET 0.001
			// 定义R,G,B通道的代表波长 (单位:纳米 nm)
      #define LAMBDA_R 656.3 
      #define LAMBDA_G 587.6
      #define LAMBDA_B 486.1

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
      uniform vec3 color;
      uniform mat4 modelMatrix;
      uniform float fresnelFactor;
      uniform float cauchyA;
      uniform float cauchyB;
      uniform vec3 absorptionColor;
      uniform float fireLuminanceThreshold;
      uniform float fireSpread;

      #include <cube_uv_reflection_fragment>
      
      // -- 柯西方程函数 --
      float getIor( float lambda ) {
        return cauchyA + cauchyB / ( lambda * lambda );
      }

      // -- 修改后的内部追踪函数, 新增 totalDist 输出 --
      vec3 totalInternalReflection( vec3 incomingOrigin, vec3 incomingDirection, vec3 surfaceNormal, float ior, mat4 modelMatrixInverse, out float totalDist ) {
        vec3 rayOrigin = incomingOrigin;
        vec3 rayDirection = incomingDirection;
        totalDist = 0.0;
        
        rayDirection = refract( rayDirection, surfaceNormal, 1.0 / ior );
        rayOrigin = vWorldPosition - surfaceNormal * RAY_OFFSET;

        rayOrigin = ( modelMatrixInverse * vec4( rayOrigin, 1.0 ) ).xyz;
        rayDirection = normalize( ( modelMatrixInverse * vec4( rayDirection, 0.0 ) ).xyz );

        for( float i = 0.0; i < bounces; i ++ ) {
          uvec4 faceIndices = uvec4( 0u );
          vec3 faceNormal = vec3( 0.0, 0.0, 1.0 );
          vec3 barycoord = vec3( 0.0 );
          float side = 1.0;
          float dist = 0.0;
          
          bvhIntersectFirstHit( bvh, rayOrigin, rayDirection, faceIndices, faceNormal, barycoord, side, dist );
          totalDist += dist; // 累加光线在内部行走的距离
          vec3 hitPos = rayOrigin + rayDirection * dist;

          vec3 refractedDirection = refract( rayDirection, faceNormal, ior );
          if ( length( refractedDirection ) == 0.0 ) {
             rayDirection = reflect( rayDirection, faceNormal );
             rayOrigin = hitPos + rayDirection * RAY_OFFSET;
          } else {
            rayDirection = refractedDirection;
            break;
          }
        }
        
        return normalize( ( modelMatrix * vec4( rayDirection, 0.0 ) ).xyz );
      }

      vec4 envSample(sampler2D envMap, vec3 rayDirection) {
				vec2 uv = equirectUv(rayDirection);
				return texture(envMap, uv);
			}

			float schlickFresnel(vec3 I, vec3 N, float R0) {
				float cosX = -dot(I, N);
				if(R0 > 1.0) return 1.0; // 物理修正
				return R0 + (1.0 - R0) * pow(clamp(1.0 - cosX, 0.0, 1.0), 5.0);
			}

      void main() {
        mat4 modelMatrixInverse = inverse( modelMatrix );
        vec3 rayDirection = normalize( vWorldPosition - cameraPosition );
        vec3 normal = normalize( vNormal );

        // -- 1. 计算不同波长的精确IOR --
        float iorR = getIor( LAMBDA_R );
        float iorG = getIor( LAMBDA_G );
        float iorB = getIor( LAMBDA_B );

        // -- 2. 计算表面反射 --
        float iorAvg = iorG; // 使用中心IOR计算菲涅尔
        float R0 = pow((1.0 - iorAvg) / (1.0 + iorAvg), 2.0);
        float fresnel = schlickFresnel(rayDirection, normal, R0);
        vec3 reflectionColor = envSample( envMap, reflect( rayDirection, normal ) ).rgb;
        
        // -- 3. 追踪内部光线并计算吸收 --
        float distR, distG, distB;
        vec3 finalDirR = totalInternalReflection( cameraPosition, rayDirection, normal, iorR, modelMatrixInverse, distR );
        vec3 finalDirG = totalInternalReflection( cameraPosition, rayDirection, normal, iorG, modelMatrixInverse, distG );
        vec3 finalDirB = totalInternalReflection( cameraPosition, rayDirection, normal, iorB, modelMatrixInverse, distB );
        
        // a. 获取色散颜色
        vec3 dispersedColor = vec3(
          envSample( envMap, finalDirR ).r,
          envSample( envMap, finalDirG ).g,
          envSample( envMap, finalDirB ).b
        );
        // b. 获取基底颜色
        vec3 nonDispersedColor = envSample( envMap, finalDirG ).rgb;

        // -- 4. 应用比尔-朗伯吸收定律 --
        // Transmittance = exp(-absorption * distance)
        vec3 absorption = vec3(
          exp(-absorptionColor.r * distR),
          exp(-absorptionColor.g * distG),
          exp(-absorptionColor.b * distB)
        );
        dispersedColor *= absorption;
        nonDispersedColor *= absorption.ggg; // 基底颜色统一使用G通道的距离

        // -- 5. 应用亮度遮罩 (艺术控制) --
        float luminance = dot(nonDispersedColor, vec3(0.299, 0.587, 0.114));
        float fireMask = smoothstep(fireLuminanceThreshold, fireLuminanceThreshold + fireSpread, luminance);
        vec3 refractedColor = mix(nonDispersedColor, dispersedColor, fireMask);

        // -- 6. 最终混合 --
        vec3 finalColor = mix( refractedColor, reflectionColor, fresnel * fresnelFactor );

        gl_FragColor.rgb = finalColor * color;
        gl_FragColor.a = 1.0;
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
            function (gltf) {
                // 遍历加载的场景来寻找Mesh
        gltf.scene.traverse(function (child) {
            
            // 判断子对象是否是一个网格 (Mesh)
            if (child instanceof THREE.Mesh) {
                
                // 找到了！现在可以安全地获取 geometry
                const diamondGeo = child.geometry;

                // --- 后续逻辑不变 ---
                const bvh = new MeshBVH(diamondGeo, { strategy: SAH, maxLeafTris: 1 });
                diamondMaterial.uniforms.bvh.value.updateFrom(bvh);
                
                // 创建我们自己的钻石Mesh
                const diamond = new THREE.Mesh(diamondGeo, diamondMaterial);

                // 将新的Mesh添加到场景
                scene.add(diamond);

                // 注意：一旦找到我们需要的第一个Mesh，就可以停止后续不必要的遍历。
                // 但在这个简单场景中，直接执行即可。
            }
        });
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